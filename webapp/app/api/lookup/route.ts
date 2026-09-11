import { NextRequest, NextResponse } from "next/server";
import { getCharacterProfile, hasData, runsEstimate, toServerSlug } from "@/lib/wcl";

const ZONE_ID = Number(process.env.WCL_ZONE_ID);
const PARTITION = Number(process.env.WCL_PARTITION);
const REGION = process.env.WCL_REGION ?? "EU";

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

export interface LookupResult {
  key: string;
  name: string;
  realm: string;
  classId: number | null;
  found: boolean;
  best?: number;
  median?: number;
  runs?: number;
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

async function lookupOne(name: string, realm: string): Promise<LookupResult> {
  const key = `${name}-${realm}`;
  const slug = toServerSlug(realm);

  try {
    const profile = await getCharacterProfile(name, slug, REGION, ZONE_ID, PARTITION);
    const zr = profile?.zoneRankings ?? null;
    if (hasData(zr)) {
      return {
        key,
        name,
        realm,
        classId: profile!.classId,
        found: true,
        best: zr.bestPerformanceAverage,
        median: zr.medianPerformanceAverage ?? undefined,
        runs: runsEstimate(zr),
      };
    }
    return { key, name, realm, classId: profile?.classId ?? null, found: false };
  } catch (err) {
    return { key, name, realm, classId: null, found: false, error: (err as Error).message };
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

export async function POST(req: NextRequest) {
  if (!ZONE_ID || !PARTITION) {
    return NextResponse.json(
      { error: "Server-Konfiguration unvollstaendig: WCL_ZONE_ID/WCL_PARTITION nicht gesetzt" },
      { status: 500 }
    );
  }

  let rawNames: unknown;
  try {
    rawNames = (await req.json())?.names;
  } catch {
    return NextResponse.json({ error: "Ungueltiger Request-Body" }, { status: 400 });
  }
  if (!Array.isArray(rawNames)) {
    return NextResponse.json({ error: "\"names\" muss ein Array von Strings sein" }, { status: 400 });
  }

  const entries = (rawNames as unknown[])
    .filter((l): l is string => typeof l === "string")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseNameRealm)
    .filter((e): e is { name: string; realm: string } => e !== null);

  if (entries.length === 0) {
    return NextResponse.json({ error: "Keine gueltigen \"Name-Realm\" Eintraege gefunden" }, { status: 400 });
  }

  const results = await mapWithConcurrency(entries, CONCURRENCY, ({ name, realm }) => lookupOne(name, realm));

  return NextResponse.json({ results });
}
