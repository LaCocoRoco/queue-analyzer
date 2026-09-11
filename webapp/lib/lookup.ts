// lib/lookup.ts
//
// Orchestrates the actual WCL lookups for a pasted applicant list. Runs
// entirely in the browser (see lib/wcl.ts for why that's safe/possible) --
// this used to be a Next.js API route (server-side), moved here unchanged
// in logic when the app became a static export with no server at all.

import { getCharacterProfile, hasData, runsEstimate, toServerSlug } from "./wcl";

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

  try {
    const profile = await getCharacterProfile(name, slug, REGION, ZONE_ID, PARTITION, clientId, clientSecret);

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
      };
    }
    // Known to WCL (or not) but no logs for this zone/partition -- show as
    // a flat 0 rather than a placeholder string.
    return { key, name, realm, classId: profile?.classId ?? null, found: false, best: 0, median: 0, runs: 0 };
  } catch (err) {
    return { key, name, realm, classId: null, found: false, best: 0, median: 0, runs: 0, error: (err as Error).message };
  }
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
