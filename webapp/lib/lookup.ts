// lib/lookup.ts
//
// Orchestrates the actual WCL lookups for a pasted applicant list. Runs
// entirely in the browser (see lib/wcl.ts for why that's safe/possible) --
// this used to be a Next.js API route (server-side), moved here unchanged
// in logic when the app became a static export with no server at all.

import { getCharacterProfile, getCurrentSeason, hasData, runsEstimate, toServerSlug, type Role } from "./wcl";
import { getRioProfile } from "./rio";

export const REGION = process.env.NEXT_PUBLIC_WCL_REGION ?? "EU";

// How many characters to process at once. WCL's rate limit is a
// points/hour budget (~3600/hour, ~1 point/query -- see lib/wcl.ts) which a
// typical Group Finder batch (a few dozen names) barely dents, and
// raider.io's documented unauthenticated cap is 200 requests/minute -- for
// a short burst like this, neither is the binding constraint.
const CONCURRENCY = 10;

// Thrown for the two user-facing failure cases here, carrying a stable code
// instead of a hardcoded-language message -- the UI maps the code to the
// current locale's translation (see lib/i18n.ts). Anything else (actual WCL
// API errors) is left as a plain Error and shown as-is; those come from a
// third party and aren't worth translating.
export class LookupError extends Error {
  code: "NO_VALID_ENTRIES" | "CONFIG_INCOMPLETE";
  constructor(code: LookupError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface LookupResult {
  key: string;
  name: string;
  realm: string;
  classId: number | null;
  found: boolean;
  // addonRole if the addon sent one, else WCL's own cached role, else null
  // -- see lookupOne. Tanks and healers are no longer excluded from results
  // (everyone gets a Log value now), but they're excluded from ranking
  // (withRanks gives them rank 0) and sorted to the end of the display
  // table -- "rank" only ever meant "how does this DPS compare to the
  // other DPS applicants".
  role: Role | null;
  // Season and Dungeon values are BOTH always fetched (one WCL query
  // already returns everything -- see lookupOne) and kept side by side
  // here, rather than collapsing to a single best/median/runs at fetch
  // time based on whichever mode was active then. That's what lets the
  // Season/Dungeon toggle update the table instantly on click (see
  // withEffectiveMode below) -- the alternative (picking one at fetch
  // time) meant switching the toggle after the fact did nothing until you
  // re-imported, since the original applicant list isn't kept around to
  // redo the lookup with.
  seasonBest: number;
  seasonMedian: number;
  seasonRuns: number;
  dungeonBest: number;
  dungeonMedian: number;
  dungeonRuns: number;
  // raider.io data -- 0/grey until fetchRioScores() has been run for this
  // result (lazy: only fetched once the "Filter" toggle is switched on,
  // see LookupForm.tsx -- raider.io's on-demand "crawl" for a character it
  // hasn't recently cached can take several seconds, so this is skipped
  // entirely for the common case of never enabling Filter at all).
  ioScore: number;
  // raider.io's own color for ioScore (see lib/rio.ts) -- their gradient,
  // not something we compute ourselves.
  ioColor: string;
  itemLevel: number;
  // Blizzard's own in-game Mythic+ rating (C_LFGList's dungeonScore), sent
  // by the addon alongside each Name-Realm in the export -- see
  // parseClipboardText. A DIFFERENT number from raider.io's ioScore
  // (independently calculated, not the same value, just correlated) --
  // used as the fast, no-network default for the "IO" ranking slot when
  // the RaiderIO toggle is off, see LookupForm.tsx.
  blizzardScore: number;
  // Blizzard's own item level (member.ItemLevel, same call as dungeonScore
  // above -- see Core.lua's GetApplicantNames), sent by the addon alongside
  // every export. Used as the fast, no-network default for the iLvl table
  // column when raider.io hasn't been fetched (its own itemLevel takes over
  // once fetchRioScores has run, same handoff as blizzardScore/ioScore).
  blizzardItemLevel: number;
  error?: string;
}

const NO_IO_COLOR = "#9D9D9D";

function parseNameRealm(line: string): { name: string; realm: string } | null {
  // Character names never contain "-"; realm names emitted by the addon
  // have spaces stripped but no hyphens inserted -- so the FIRST "-" is
  // always the correct split point.
  const idx = line.indexOf("-");
  if (idx <= 0 || idx === line.length - 1) return null;
  return { name: line.slice(0, idx), realm: line.slice(idx + 1) };
}

// Blizzard's own assignedRole string (see Core.lua's GetApplicantNames) --
// "TANK"/"HEALER"/"DAMAGER" is the standard convention used across
// Blizzard's own APIs (e.g. UnitGroupRolesAssigned). This is the role
// Blizzard itself resolved for THIS SPECIFIC application, not the raw
// tank/healer/damage capability flags (which can all be true at once for a
// flexible/multi-spec application) -- exactly the thing that would
// otherwise have to be guessed at from a cached, possibly-stale WCL spec
// lookup. Returns null for "NONE"/empty/anything unrecognized, in which
// case lookupOne falls back to WCL's own gameData-derived role instead.
function parseAssignedRole(raw: string): Role | null {
  switch (raw) {
    case "TANK":
      return "tank";
    case "HEALER":
      return "healer";
    case "DAMAGER":
      return "dps";
    default:
      return null;
  }
}

// The addon exports "Name:Server:ItemLevel:Score:Role:Name:Server:ItemLevel:
// Score:Role:...:Dungeon:EXPORT" (see Core.lua's GetApplicantNames/
// QueueAnalyzer_RefreshExport) -- fixed quintuplets (Name, Server,
// Blizzard's own item level, Blizzard's own in-game Mythic+ rating,
// Blizzard's own assignedRole) for every applicant member, followed by ONE
// trailing Dungeon field (the leader's current Keystone dungeon, empty if
// none -- see Core.lua's GetCurrentDungeonName) and the "EXPORT" marker.
// Dungeon sits at the END, not repeated per applicant, since it's a single
// value for the whole listing -- repeating it per member would be pure
// waste. Name/Server are separate fields rather than one hyphenated
// "Name-Realm" string -- avoids ever having to guess a split point on a
// realm name (some contain non-ASCII/parenthesized parts).
//
// The trailing "EXPORT" marker is what toExportString below writes back as
// "IMPORT" instead -- the two formats used to be similar enough in shape
// that pasting the Export field straight back into itself got silently
// accepted as real ranked data. An empty clipboard (nothing copied yet) is
// not an error here -- runLookup's caller already surfaces "no names" for
// that; this only rejects non-empty text that isn't actually the addon's
// Export output.
export function parseClipboardText(rawText: string): {
  dungeonName: string | null;
  entries: { key: string; blizzardScore: number; blizzardItemLevel: number; addonRole: Role | null }[];
} {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return { dungeonName: null, entries: [] };
  }
  if (!trimmed.endsWith(":EXPORT")) {
    throw new Error("Clipboard doesn't look like the addon's Export field (Import result pasted by mistake?).");
  }

  const tokens = trimmed.slice(0, -":EXPORT".length).split(":");
  const dungeonName = tokens[tokens.length - 1]?.trim() || null;
  const memberTokens = tokens.slice(0, -1);

  const entries: { key: string; blizzardScore: number; blizzardItemLevel: number; addonRole: Role | null }[] = [];
  for (let i = 0; i + 4 < memberTokens.length; i += 5) {
    const name = memberTokens[i];
    const server = memberTokens[i + 1];
    if (!name || !server) continue;
    entries.push({
      key: `${name}-${server}`,
      blizzardItemLevel: Number(memberTokens[i + 2]) || 0,
      blizzardScore: Number(memberTokens[i + 3]) || 0,
      addonRole: parseAssignedRole(memberTokens[i + 4]),
    });
  }
  return { dungeonName, entries };
}

// Everyone gets a Log value now -- tanks and healers are no longer
// excluded from the results, just from ranking (see withRanks). addonRole
// (Blizzard's own assignedRole for this specific application, see
// parseClipboardText) picks the metric for the WCL query itself (damage
// vs. healing) -- it has to be known BEFORE fetching, so unlike other
// per-character data this can't wait on WCL's own gameData-derived role,
// which only arrives as PART OF that same fetch. Falls back to treating an
// unknown/missing addonRole as damage-focused (points_and_damage/dps) by
// default. The FINAL role recorded on the result (used later for ranking)
// still prefers addonRole but falls back to WCL's cached role if the addon
// didn't send one at all.
async function lookupOne(
  name: string,
  realm: string,
  zoneID: number,
  partition: number,
  encounterID: number | undefined,
  addonRole: Role | null,
  clientId: string,
  clientSecret: string
): Promise<LookupResult | null> {
  const key = `${name}-${realm}`;
  const slug = toServerSlug(realm);

  let profile;
  try {
    profile = await getCharacterProfile(
      name,
      slug,
      REGION,
      zoneID,
      partition,
      clientId,
      clientSecret,
      encounterID,
      addonRole
    );
  } catch (err) {
    return {
      key,
      name,
      realm,
      classId: null,
      found: false,
      role: addonRole,
      seasonBest: 0,
      seasonMedian: 0,
      seasonRuns: 0,
      dungeonBest: 0,
      dungeonMedian: 0,
      dungeonRuns: 0,
      ioScore: 0,
      ioColor: NO_IO_COLOR,
      blizzardScore: 0,
      blizzardItemLevel: 0,
      itemLevel: 0,
      error: (err as Error).message,
    };
  }

  const role = addonRole ?? profile?.role ?? null;
  const zr = profile?.zoneRankings ?? null;
  if (hasData(zr)) {
    // Season: bestPerformanceAverage/medianPerformanceAverage straight from
    // the points_and_damage response (confirmed live against a real
    // character's own WCL page: 44.375 matched exactly). Dungeon: a
    // SEPARATE encounterRankings query (see getCharacterProfile) -- its
    // medianPerformance/averagePerformance are identical to each other in
    // this response shape (no distinct "best" percentile at the per-dungeon
    // level), so both dungeonBest and dungeonMedian just use it directly.
    // Both season and dungeon fields are always computed here regardless of
    // which mode is currently selected (see LookupResult's comment for
    // why) -- a character who simply hasn't run this particular dungeon
    // this season gets null encounterRankings, which correctly shows as
    // "no data" (0) for the dungeon fields without affecting the season
    // fields.
    const er = profile?.encounterRankings ?? null;

    return {
      key,
      name,
      realm,
      classId: profile!.classId,
      found: true,
      role,
      seasonBest: zr.bestPerformanceAverage ?? 0,
      seasonMedian: zr.medianPerformanceAverage ?? 0,
      seasonRuns: runsEstimate(zr),
      dungeonBest: er?.medianPerformance ?? 0,
      dungeonMedian: er?.averagePerformance ?? 0,
      dungeonRuns: er?.totalKills ?? 0,
      ioScore: 0,
      ioColor: NO_IO_COLOR,
      blizzardScore: 0,
      blizzardItemLevel: 0,
      itemLevel: 0,
    };
  }
  // Known to WCL (or not) but no logs for this zone/partition -- show as
  // a flat 0 rather than a placeholder string.
  return {
    key,
    name,
    realm,
    classId: profile?.classId ?? null,
    found: false,
    role,
    seasonBest: 0,
    seasonMedian: 0,
    seasonRuns: 0,
    dungeonBest: 0,
    dungeonMedian: 0,
    dungeonRuns: 0,
    ioScore: 0,
    ioColor: NO_IO_COLOR,
    blizzardScore: 0,
    blizzardItemLevel: 0,
    itemLevel: 0,
  };
}

// Which of the season/dungeon field pairs is currently "the" best/median/
// runs to rank and display by -- computed fresh on every call (cheap, pure)
// so the Season/Dungeon toggle takes effect immediately on click, no
// re-lookup needed (see LookupResult's comment).
export interface EffectiveResult extends LookupResult {
  best: number;
  median: number;
  runs: number;
}

export function withEffectiveMode(results: LookupResult[], dungeonMode: "season" | "dungeon"): EffectiveResult[] {
  return results.map((r) => ({
    ...r,
    best: dungeonMode === "dungeon" ? r.dungeonBest : r.seasonBest,
    median: dungeonMode === "dungeon" ? r.dungeonMedian : r.seasonMedian,
    runs: dungeonMode === "dungeon" ? r.dungeonRuns : r.seasonRuns,
  }));
}

// Fetches raider.io data for an existing result set and returns a new array
// with ioScore/ioColor/itemLevel filled in -- called separately (and
// lazily, only when needed) rather than as part of lookupOne/runLookup, see
// LookupResult's ioScore field comment for why.
export async function fetchRioScores(results: LookupResult[], region: string): Promise<LookupResult[]> {
  return mapWithConcurrency(results, CONCURRENCY, async (r) => {
    const rio = await getRioProfile(r.name, toServerSlug(r.realm), region);
    // Falls back to Blizzard's own item level (already sitting in
    // r.itemLevel from the addon export) rather than 0 when raider.io has
    // no profile for this character -- a missing raider.io lookup shouldn't
    // blank out a value we already have.
    return {
      ...r,
      ioScore: rio?.score ?? 0,
      ioColor: rio?.color ?? NO_IO_COLOR,
      itemLevel: rio?.itemLevel ?? r.itemLevel,
    };
  });
}

// Runs `fn` over `items` with at most `concurrency` in flight at once --
// each of `concurrency` workers pulls the next item off a shared index
// until the list is exhausted, so results.length worth of work finishes in
// about (items.length / concurrency) request-latencies instead of
// items.length of them.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export interface ScoredResult extends EffectiveResult {
  score: number;
}

// Combines WCL's Best percentile (already 0-100) with raider.io's Mythic+
// score into one weighted value, for the optional "Filter" ranking mode.
// The raw IO score (e.g. 1800-3000) isn't on the same 0-100 scale as a WCL
// percentile, so it's min-max normalized across the current batch first
// (lowest applicant -> 0, highest -> 100) before weighting.
// logsWeight/ioWeight are two independent 0-100 sliders, not required to
// sum to 100 -- dividing by their sum means e.g. both at 50 is a plain
// average of the two normalized scores, matching what "50/50" should mean.
// A character raider.io has no profile for gets ioNorm 0 (worst case)
// rather than being skipped or given a free-pass average -- an unknown
// score shouldn't rank the same as a verified middling one.
export function rankResults(results: EffectiveResult[], logsWeight: number, ioWeight: number): ScoredResult[] {
  const withIo = results.filter((r) => r.ioScore > 0);
  const ioMin = withIo.length ? Math.min(...withIo.map((r) => r.ioScore)) : 0;
  const ioMax = withIo.length ? Math.max(...withIo.map((r) => r.ioScore)) : 0;
  const totalWeight = logsWeight + ioWeight;

  const scored: ScoredResult[] = results.map((r) => {
    const logsNorm = r.best;
    const ioNorm = r.ioScore <= 0 ? 0 : ioMax > ioMin ? ((r.ioScore - ioMin) / (ioMax - ioMin)) * 100 : 50;
    const score = totalWeight > 0 ? (logsWeight * logsNorm + ioWeight * ioNorm) / totalWeight : 0;
    return { ...r, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

export interface RankedResult extends EffectiveResult {
  rank: number;
}

// Same weighted scoring as rankResults, but returns results in their
// ORIGINAL order with a .rank attached (1 = best) instead of physically
// reordering them. WoW's Group Finder applicant list can't be reordered by
// an addon (confirmed against Blizzard's own LFGList.lua), so re-sorting
// the webapp's own view would just make it harder to match against the
// in-game list -- the rank NUMBER is the useful artifact here, not the
// row order. Tanks and healers are excluded from the ranking pool itself
// (rank only ever meant "how does this DPS compare to the other DPS
// applicants") and get rank 0 -- the same sentinel already used for
// "Filter wasn't on for this export", so the addon-side display/coloring
// logic doesn't need a separate code path for it.
export function withRanks(results: EffectiveResult[], logsWeight: number, ioWeight: number): RankedResult[] {
  const rankable = results.filter((r) => r.role !== "tank" && r.role !== "healer");
  const scored = rankResults(rankable, logsWeight, ioWeight);
  const rankByKey = new Map(scored.map((r, i) => [r.key, i + 1]));
  return results.map((r) => ({ ...r, rank: rankByKey.get(r.key) ?? 0 }));
}

// dungeonName: the addon-exported current Keystone dungeon (see
// parseClipboardText), or null if there wasn't one. Always resolved and
// fetched regardless of which mode the Season/Dungeon toggle is currently
// in -- see LookupResult's comment for why (lets the toggle switch
// instantly later without a re-lookup). An unrecognized name (not in the
// current season's encounter list, or simply no active Keystone listing)
// just leaves encounterID undefined below, so the dungeon-specific fields
// end up 0 ("no data") rather than erroring.
//
// roleByKey: Blizzard's own assignedRole per applicant (see
// parseClipboardText/parseAssignedRole), keyed by "Name-Realm" -- passed
// through to lookupOne so the tank/healer exclusion can use it instead of
// (or as well as) WCL's own cached role.
export async function runLookup(
  rawNames: string[],
  clientId: string,
  clientSecret: string,
  dungeonName: string | null,
  roleByKey: Map<string, Role | null>
): Promise<LookupResult[]> {
  const season = await getCurrentSeason(clientId, clientSecret);
  if (!season.zoneID || !season.partition) {
    throw new LookupError("CONFIG_INCOMPLETE");
  }
  const encounterID = dungeonName ? season.encountersByName.get(dungeonName.toLowerCase()) : undefined;

  const entries = rawNames
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNameRealm)
    .filter((e): e is { name: string; realm: string } => e !== null);

  if (entries.length === 0) {
    throw new LookupError("NO_VALID_ENTRIES");
  }

  const results = (
    await mapWithConcurrency(entries, CONCURRENCY, ({ name, realm }) =>
      lookupOne(
        name,
        realm,
        season.zoneID,
        season.partition,
        encounterID,
        roleByKey.get(`${name}-${realm}`) ?? null,
        clientId,
        clientSecret
      )
    )
  ).filter((r): r is LookupResult => r !== null);

  return results;
}
