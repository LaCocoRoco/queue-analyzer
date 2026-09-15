// lib/lookup.ts
//
// Orchestrates the actual WCL lookups for a pasted applicant list. Runs
// entirely in the browser (see lib/wcl.ts for why that's safe/possible) --
// this used to be a Next.js API route (server-side), moved here unchanged
// in logic when the app became a static export with no server at all.

import {
  CLASS_ID_BY_SPEC_ID,
  getCharacterProfile,
  getCurrentRaidZone,
  getCurrentSeason,
  hasData,
  runsEstimate,
  toServerSlug,
  type Role,
} from "./wcl";
import { getRioProfile } from "./rio";
import { getSpecTiers, type TierGrade } from "./rioTier";

export const REGION = process.env.NEXT_PUBLIC_WCL_REGION ?? "EU";

// How many characters to process at once. WCL's rate limit is a
// points/hour budget (~3600/hour, ~1 point/query -- see lib/wcl.ts) which a
// typical Group Finder batch (a few dozen names) barely dents, and
// raider.io's documented unauthenticated cap is 200 requests/minute -- for
// a short burst like this, neither is the binding constraint.
const CONCURRENCY = 10;

// The addon version this webapp build was written against -- bump this
// alongside QueueAnalyzer.toc's "## Version:" line whenever the clipboard
// format changes in a way that breaks compatibility (like this one did).
// Embedded in both directions: the addon's Export string ends in
// "e<its own .toc version>" (checked against this constant below), and the
// webapp's own Import string echoes this same value back as "i<version>"
// for the addon to check against ITS OWN version (see Core.lua's
// ParseImportText) -- so either side running a mismatched build gets a
// clear "wrong version" error instead of silently misreading a format it
// doesn't actually speak.
export const EXPECTED_ADDON_VERSION = "2.0.0";

// Thrown for the user-facing failure cases here, carrying a stable code
// instead of a hardcoded-language message -- the UI maps the code to the
// current locale's translation (see lib/i18n.ts). Anything else (actual WCL
// API errors) is left as a plain Error and shown as-is; those come from a
// third party and aren't worth translating.
export class LookupError extends Error {
  code: "NO_VALID_ENTRIES" | "CONFIG_INCOMPLETE" | "WRONG_ADDON_VERSION";
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
  // Blizzard's own numeric spec ID (see wcl.ts's extractSpecId), or null if
  // unknown -- used only to look up this spec's RaiderIO Tier grade below,
  // kept separate from `role` since e.g. "Blood" vs "Frost" Death Knight
  // share a role but not a specId.
  specId: number | null;
  // Spec-strength grade (S/A/B/C) from raider.io's cutoff-analysis (see
  // lib/rioTier.ts) -- how strong this applicant's SPEC currently is
  // relative to every other spec, NOT how well this specific applicant
  // plays it (that's `best`/the Log value). Filled in by runLookup after
  // the main WCL pass, once per batch (one shared raider.io fetch, not one
  // per character) -- null until then, or permanently null if raider.io has
  // no cutoff data for this specId at all. Deliberately not folded into
  // ranking -- informational only, per explicit request.
  tier: TierGrade | null;
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

// Blizzard's own assignedRole (see Core.lua's GetApplicantMemberInfo --
// "TANK"/"HEALER"/"DAMAGER" is the standard convention used across
// Blizzard's own APIs, e.g. UnitGroupRolesAssigned), shortened by the addon
// to a single letter (AssignedRoleCode in Core.lua) before export -- one
// more field per applicant member adds up fast in a one-line EditBox. This
// is the role Blizzard itself resolved for THIS SPECIFIC application, not
// the raw tank/healer/damage capability flags (which can all be true at
// once for a flexible/multi-spec application) -- exactly the thing that
// would otherwise have to be guessed at from a cached, possibly-stale WCL
// spec lookup. Returns null for an empty/unrecognized code (the addon sends
// "" for Blizzard's "NONE" or an unknown value), in which case lookupOne
// falls back to WCL's own gameData-derived role instead.
function parseAssignedRole(raw: string): Role | null {
  switch (raw) {
    case "T":
      return "tank";
    case "H":
      return "healer";
    case "D":
      return "dps";
    default:
      return null;
  }
}

export type ContentType = "mythicplus" | "raid";
// Single-letter raid difficulty code, exactly as the addon exports it (see
// Core.lua's AssignedRoleCode-style GetCurrentInstanceInfo) -- "-" (Mythic+,
// not applicable) never reaches this type, see parseClipboardText.
export type RaidDifficultyCode = "N" | "H" | "M";

// The addon exports "Name:Server:Role:ItemLevel:Score:SpecID:Name:Server:
// Role:ItemLevel:Score:SpecID:...:Type:Difficulty:InstanceName:EXPORT" (see
// Core.lua's GetApplicantNames/QueueAnalyzer_RefreshExport) -- fixed
// sextuplets (Name, Server, Blizzard's own assignedRole, Blizzard's own
// item level, Blizzard's own in-game Mythic+ rating, Blizzard's own active
// spec ID) for every applicant member, followed by exactly THREE trailing
// fields (Type: "M"|"R", Difficulty: "-"|"N"|"H"|"M", InstanceName) and the
// "EXPORT" marker. SpecID is Blizzard's own LIVE value (same call as
// everything else here, zero extra cost) -- lets the RaiderIO Tier grade
// (lib/rioTier.ts) skip WCL's gameData lookup entirely for characters the
// addon already told us the spec of, instead of needing a slow forceUpdate
// call or accepting gaps where WCL hasn't independently cached it (see
// lookupOne). Type/Difficulty/InstanceName sit at the END, not repeated per
// applicant, since they're single values for the whole listing --
// repeating them per member would be pure waste. Name/Server are separate
// fields rather than one hyphenated "Name-Realm" string -- avoids ever
// having to guess a split point on a realm name (some contain
// non-ASCII/parenthesized parts).
//
// The trailing "e<version>" marker is what toExportString below writes back
// as "i<version>" instead -- the two formats used to be similar enough in
// shape that pasting the Export field straight back into itself got
// silently accepted as real ranked data. Only the embedded version's MAJOR
// component has to match EXPECTED_ADDON_VERSION's -- minor/patch
// differences are assumed backwards compatible, only a MAJOR mismatch means
// this webapp build and the addon build actually disagree on the data
// format, which is a LookupError (WRONG_ADDON_VERSION) so the button can
// show a specific message instead of the generic clipboard-format one. An
// empty clipboard (nothing copied yet) is not an error here -- runLookup's
// caller already surfaces "no names" for that; this only rejects non-empty
// text that isn't actually the addon's Export output.
function majorVersion(version: string): string {
  return version.split(".")[0];
}

export function parseClipboardText(rawText: string): {
  contentType: ContentType;
  raidDifficultyCode: RaidDifficultyCode | null;
  instanceName: string | null;
  entries: {
    key: string;
    blizzardScore: number;
    blizzardItemLevel: number;
    addonRole: Role | null;
    addonSpecId: number | null;
  }[];
} {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return { contentType: "mythicplus", raidDifficultyCode: null, instanceName: null, entries: [] };
  }
  const markerMatch = /:e([^:]+)$/.exec(trimmed);
  if (!markerMatch) {
    throw new Error("Clipboard doesn't look like the addon's Export field (Import result pasted by mistake?).");
  }
  if (majorVersion(markerMatch[1]) !== majorVersion(EXPECTED_ADDON_VERSION)) {
    throw new LookupError("WRONG_ADDON_VERSION");
  }

  const tokens = trimmed.slice(0, -markerMatch[0].length).split(":");
  const instanceName = tokens[tokens.length - 1]?.trim() || null;
  const difficultyToken = tokens[tokens.length - 2] ?? "-";
  const contentType: ContentType = tokens[tokens.length - 3] === "R" ? "raid" : "mythicplus";
  const raidDifficultyCode: RaidDifficultyCode | null =
    contentType === "raid" && (difficultyToken === "N" || difficultyToken === "H" || difficultyToken === "M")
      ? difficultyToken
      : null;
  const memberTokens = tokens.slice(0, -3);

  const entries: {
    key: string;
    blizzardScore: number;
    blizzardItemLevel: number;
    addonRole: Role | null;
    addonSpecId: number | null;
  }[] = [];
  for (let i = 0; i + 5 < memberTokens.length; i += 6) {
    const name = memberTokens[i];
    const server = memberTokens[i + 1];
    if (!name || !server) continue;
    entries.push({
      key: `${name}-${server}`,
      addonRole: parseAssignedRole(memberTokens[i + 2]),
      blizzardItemLevel: Number(memberTokens[i + 3]) || 0,
      blizzardScore: Number(memberTokens[i + 4]) || 0,
      addonSpecId: Number(memberTokens[i + 5]) || null,
    });
  }
  return { contentType, raidDifficultyCode, instanceName, entries };
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
// didn't send one at all. addonSpecId is the same idea applied to the
// RaiderIO Tier grade AND to classId (the class-color table column) --
// always preferred over WCL's own gameData (which needs a slow forceUpdate
// call, or is just null if WCL never independently cached it -- see wcl.ts's
// CHARACTER_PROFILE_QUERY comment), falling back to it only if the addon
// didn't send a usable specId (CLASS_ID_BY_SPEC_ID is a pure, always-correct
// lookup once a specId is known at all).
async function lookupOne(
  name: string,
  realm: string,
  zoneID: number,
  partition: number,
  encounterID: number | undefined,
  addonRole: Role | null,
  addonSpecId: number | null,
  clientId: string,
  clientSecret: string,
  contentType: ContentType,
  difficultyId: number | undefined
): Promise<LookupResult | null> {
  const key = `${name}-${realm}`;
  const slug = toServerSlug(realm);
  // Computed upfront, before the WCL call even resolves -- doesn't depend
  // on `profile` at all when the addon sent a recognized specId.
  const addonClassId = addonSpecId != null ? (CLASS_ID_BY_SPEC_ID[addonSpecId] ?? null) : null;

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
      addonRole,
      contentType,
      difficultyId
    );
  } catch (err) {
    return {
      key,
      name,
      realm,
      classId: addonClassId,
      found: false,
      role: addonRole,
      specId: addonSpecId,
      tier: null,
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
      classId: addonClassId ?? profile!.classId,
      found: true,
      role,
      specId: addonSpecId ?? profile!.specId,
      tier: null,
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
    classId: addonClassId ?? profile?.classId ?? null,
    found: false,
    role,
    specId: addonSpecId ?? profile?.specId ?? null,
    tier: null,
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

// Score (raider.io or Blizzard's in-game rating) is normalized against this
// fixed absolute scale, not min-max'd across the current applicant batch --
// confirmed live that min-max was the actual bug behind "unranked stayed
// ranked": a batch where every applicant's score already sits close together
// (e.g. 2535-2588) got stretched to fill the WHOLE 0-100 range regardless,
// so a trivial real difference in Score could swamp a huge, meaningful
// difference in Log (like 0 vs 37). A fixed ceiling keeps a tight cluster of
// real scores mapping to a correspondingly tight cluster of ioNorm, so Log
// isn't drowned out by noise. 4000 is comfortably above what the current
// Mythic+ scoring curve produces for a realistic top-end player; clamped to
// 100 in case a future season's scores creep past it anyway.
const IO_SCORE_CEILING = 4000;

// Combines WCL's Best percentile (already 0-100) with raider.io's Mythic+
// score into one weighted value, for the optional "Filter" ranking mode.
// logsWeight/ioWeight are two independent 0-100 sliders, not required to
// sum to 100 -- dividing by their sum means e.g. both at 50 is a plain
// average of the two normalized scores, matching what "50/50" should mean.
// A character raider.io has no profile for gets ioNorm 0 (worst case)
// rather than being skipped or given a free-pass average -- an unknown
// score shouldn't rank the same as a verified middling one.
export function rankResults(results: EffectiveResult[], logsWeight: number, ioWeight: number): ScoredResult[] {
  const totalWeight = logsWeight + ioWeight;

  const scored: ScoredResult[] = results.map((r) => {
    const logsNorm = r.best;
    const ioNorm = r.ioScore <= 0 ? 0 : Math.min(100, (r.ioScore / IO_SCORE_CEILING) * 100);
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

// WCL's own difficulty names (lowercased) for the current raid zone,
// confirmed live -- keyed by the addon's single-letter export code (see
// RaidDifficultyCode/Core.lua's GetCurrentInstanceInfo).
const RAID_DIFFICULTY_NAME: Record<RaidDifficultyCode, string> = { N: "normal", H: "heroic", M: "mythic" };

// contentType/instanceName/raidDifficultyCode: the addon-exported listing
// info (see parseClipboardText). For Mythic+, instanceName is the current
// Keystone dungeon (or null if none) -- an unrecognized name (not in the
// current season's encounter list) just leaves encounterID undefined below,
// so the dungeon-specific fields end up 0 ("no data") rather than erroring.
// For raid, there's no per-boss detection at all (Group Finder doesn't
// expose "which boss is this group working on", only the raid+difficulty --
// see GetCurrentInstanceInfo's comment in Core.lua), so encounterID always
// stays undefined and Dungeon-mode fields simply stay 0 for raid results,
// same fallback as an unmatched Mythic+ dungeon name. difficulty IS
// required for raid, unlike Mythic+ (see RaidZoneInfo's comment in
// lib/wcl.ts) -- resolved here from the raid zone's own difficulty list,
// not guessed.
//
// roleByKey: Blizzard's own assignedRole per applicant (see
// parseClipboardText/parseAssignedRole), keyed by "Name-Realm" -- passed
// through to lookupOne so the tank/healer exclusion can use it instead of
// (or as well as) WCL's own cached role.
//
// specIdByKey: Blizzard's own live active spec ID per applicant (see
// parseClipboardText), same idea as roleByKey -- passed through to
// lookupOne so the RaiderIO Tier grade doesn't have to wait on (or fall
// back to gaps in) WCL's own gameData.specId.
export async function runLookup(
  rawNames: string[],
  clientId: string,
  clientSecret: string,
  contentType: ContentType,
  instanceName: string | null,
  raidDifficultyCode: RaidDifficultyCode | null,
  roleByKey: Map<string, Role | null>,
  specIdByKey: Map<string, number | null>
): Promise<LookupResult[]> {
  let zoneID: number;
  let partition: number;
  let encounterID: number | undefined;
  let difficultyId: number | undefined;

  if (contentType === "raid") {
    const raidZone = await getCurrentRaidZone(clientId, clientSecret);
    difficultyId = raidDifficultyCode
      ? raidZone?.difficultiesByName.get(RAID_DIFFICULTY_NAME[raidDifficultyCode])
      : undefined;
    if (!raidZone?.zoneID || !raidZone.partition || difficultyId == null) {
      throw new LookupError("CONFIG_INCOMPLETE");
    }
    zoneID = raidZone.zoneID;
    partition = raidZone.partition;
  } else {
    const season = await getCurrentSeason(clientId, clientSecret);
    if (!season.zoneID || !season.partition) {
      throw new LookupError("CONFIG_INCOMPLETE");
    }
    zoneID = season.zoneID;
    partition = season.partition;
    encounterID = instanceName ? season.encountersByName.get(instanceName.toLowerCase()) : undefined;
  }

  const entries = rawNames
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNameRealm)
    .filter((e): e is { name: string; realm: string } => e !== null);

  if (entries.length === 0) {
    throw new LookupError("NO_VALID_ENTRIES");
  }

  // Fetched in parallel with the main WCL pass, not after it -- the tier
  // map doesn't depend on `results` at all, and is cached (see
  // getSpecTiers/lib/rioTier.ts) so every Import after the first resolves
  // this instantly anyway.
  const [rawResults, tierBySpec] = await Promise.all([
    mapWithConcurrency(entries, CONCURRENCY, ({ name, realm }) =>
      lookupOne(
        name,
        realm,
        zoneID,
        partition,
        encounterID,
        roleByKey.get(`${name}-${realm}`) ?? null,
        specIdByKey.get(`${name}-${realm}`) ?? null,
        clientId,
        clientSecret,
        contentType,
        difficultyId
      )
    ),
    getSpecTiers(REGION),
  ]);

  const results = rawResults
    .filter((r): r is LookupResult => r !== null)
    .map((r) => ({ ...r, tier: r.specId != null ? (tierBySpec.get(r.specId) ?? null) : null }));

  return results;
}
