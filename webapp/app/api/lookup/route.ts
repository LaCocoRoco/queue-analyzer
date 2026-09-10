import { NextRequest, NextResponse } from "next/server";
import { getCharacterZoneRankings, hasData, runsEstimate, toServerSlug } from "@/lib/wcl";

const ZONE_ID = Number(process.env.WCL_ZONE_ID);
const PARTITION = Number(process.env.WCL_PARTITION);
const REGION = process.env.WCL_REGION ?? "EU";

// Paces requests at ~3430/hour, safely under WCL's measured ~3600
// points/hour budget (1 point per query).
const REQUEST_INTERVAL_MS = 1050;

export interface LookupResult {
  key: string;
  name: string;
  realm: string;
  found: boolean;
  best?: number;
  median?: number;
  runs?: number;
  error?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNameRealm(line: string): { name: string; realm: string } | null {
  // Character names never contain "-"; realm names emitted by the addon
  // have spaces stripped but no hyphens inserted -- so the FIRST "-" is
  // always the correct split point.
  const idx = line.indexOf("-");
  if (idx <= 0 || idx === line.length - 1) return null;
  return { name: line.slice(0, idx), realm: line.slice(idx + 1) };
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

  const results: LookupResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { name, realm } = entries[i];
    const key = `${name}-${realm}`;
    const slug = toServerSlug(realm);

    try {
      const zr = await getCharacterZoneRankings(name, slug, REGION, ZONE_ID, PARTITION);
      if (hasData(zr)) {
        results.push({
          key,
          name,
          realm,
          found: true,
          best: zr.bestPerformanceAverage,
          median: zr.medianPerformanceAverage ?? undefined,
          runs: runsEstimate(zr),
        });
      } else {
        results.push({ key, name, realm, found: false });
      }
    } catch (err) {
      results.push({ key, name, realm, found: false, error: (err as Error).message });
    }

    if (i < entries.length - 1) {
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  return NextResponse.json({ results });
}
