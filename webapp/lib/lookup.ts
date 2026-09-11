// lib/lookup.ts
//
// Orchestrates the actual WCL lookups for a pasted applicant list. Runs
// entirely in the browser (see lib/wcl.ts for why that's safe/possible) --
// this used to be a Next.js API route (server-side), moved here unchanged
// in logic when the app became a static export with no server at all.

import { getCharacterProfile, hasData, runsEstimate, toServerSlug } from "./wcl";
import { getRioProfile } from "./rio";

const REGION = process.env.NEXT_PUBLIC_WCL_REGION ?? "EU";
const ZONE_ID = Number(process.env.NEXT_PUBLIC_WCL_ZONE_ID);
const PARTITION = Number(process.env.NEXT_PUBLIC_WCL_PARTITION);

// How many WCL requests to run at once. WCL's rate limit is a points/hour
// budget (~3600/hour, ~1 point/query -- see lib/wcl.ts) which a typical
// Group Finder batch (a few dozen names) barely dents, so the hourly
// budget isn't the binding constraint here -- it's whatever undocumented
// per-second/burst protection WCL's API may have (one forum report
// mentioned 429s after a few hundred rapid requests). 5 concurrent
// requests is a conservative middle ground: much faster than one-at-a-time
// without hammering the API. Raise it if this proves too conservative in
// practice.
const CONCURRENCY = 5;

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
  best: number;
  median: number;
  runs: number;
  // raider.io data, fetched in parallel with the WCL lookup -- 0 when
  // raider.io has no profile for this character (never blocks the result,
  // same as a missing WCL log).
  ioScore: number;
  itemLevel: number;
  error?: string;
}

function parseNameRealm(line: string): { name: string; realm: string } | null {
  // Character names never contain "-"; realm names emitted by the addon
  // have spaces stripped but no hyphens inserted -- so the FIRST "-" is
  // always the correct split point.
  const idx = line.indexOf("-");
  if (idx <= 0 || idx === line.length - 1) return null;
  return { name: line.slice(0, idx), realm: line.slice(idx + 1) };
}

// Returns null for characters whose current role is tank or healer -- their
// DPS percentile is meaningless and just adds noise to a DPS-focused list.
// Characters we couldn't determine a role for (no cached gameData) are kept.
async function lookupOne(name: string, realm: string, clientId: string, clientSecret: string): Promise<LookupResult | null> {
  const key = `${name}-${realm}`;
  const slug = toServerSlug(realm);

  // WCL and raider.io are two independent, unrelated APIs -- run them
  // concurrently instead of one after the other, halving the latency per
  // character. A raider.io failure never affects the WCL result or vice
  // versa (getRioProfile never throws, resolves to null instead).
  const [profileResult, rioProfile] = await Promise.all([
    getCharacterProfile(name, slug, REGION, ZONE_ID, PARTITION, clientId, clientSecret)
      .then((profile) => ({ profile, error: undefined as string | undefined }))
      .catch((err) => ({ profile: null, error: (err as Error).message })),
    getRioProfile(name, slug, REGION),
  ]);

  const ioScore = rioProfile?.score ?? 0;
  const itemLevel = rioProfile?.itemLevel ?? 0;

  if (profileResult.error) {
    return { key, name, realm, classId: null, found: false, best: 0, median: 0, runs: 0, ioScore, itemLevel, error: profileResult.error };
  }

  const profile = profileResult.profile;
  if (profile?.role === "tank" || profile?.role === "healer") {
    return null;
  }

  const zr = profile?.zoneRankings ?? null;
  if (hasData(zr)) {
    return {
      key,
      name,
      realm,
      classId: profile!.classId,
      found: true,
      best: zr.bestPerformanceAverage,
      median: zr.medianPerformanceAverage ?? 0,
      runs: runsEstimate(zr),
      ioScore,
      itemLevel,
    };
  }
  // Known to WCL (or not) but no logs for this zone/partition -- show as
  // a flat 0 rather than a placeholder string.
  return { key, name, realm, classId: profile?.classId ?? null, found: false, best: 0, median: 0, runs: 0, ioScore, itemLevel };
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

export interface ScoredResult extends LookupResult {
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
export function rankResults(results: LookupResult[], logsWeight: number, ioWeight: number): ScoredResult[] {
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

export async function runLookup(rawNames: string[], clientId: string, clientSecret: string): Promise<LookupResult[]> {
  if (!ZONE_ID || !PARTITION) {
    throw new LookupError("CONFIG_INCOMPLETE");
  }

  const entries = rawNames
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNameRealm)
    .filter((e): e is { name: string; realm: string } => e !== null);

  if (entries.length === 0) {
    throw new LookupError("NO_VALID_ENTRIES");
  }

  const results = (
    await mapWithConcurrency(entries, CONCURRENCY, ({ name, realm }) => lookupOne(name, realm, clientId, clientSecret))
  ).filter((r): r is LookupResult => r !== null);

  return results;
}
