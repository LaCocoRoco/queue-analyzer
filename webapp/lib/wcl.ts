// lib/wcl.ts
//
// WarcraftLogs API v2 client -- client-credentials flow only.
//
// This app is for personal/single-deployment use, sitting behind your own
// access control (e.g. Authentik) -- so it holds one server-side
// WCL_CLIENT_ID/WCL_CLIENT_SECRET pair and uses it for every request. No
// per-user login: confirmed live (two different WCL accounts, same
// registered client) that WCL's rate limit is tracked per API client, not
// per logged-in user -- so a login screen would not have given separate
// quotas anyway, just extra complexity.

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_ENDPOINT = "https://www.warcraftlogs.com/api/v2/client";

const CLIENT_ID = process.env.WCL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET ?? "";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Module-level cache: one token shared by every request this server
// process handles. Fine for a single-instance personal deployment.
let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const basicAuth = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`WCL-Token-Request fehlgeschlagen (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function wclGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const accessToken = await getAccessToken();

  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  const body = (await res.json()) as GraphQLResponse<T>;

  if (!res.ok || body.errors) {
    const message = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  if (!body.data) {
    throw new Error("Leere Antwort von WarcraftLogs");
  }
  return body.data;
}

// Best-effort realm-name -> WCL server-slug conversion (lowercase, no
// apostrophes, everything else collapsed to hyphens). A handful of realms
// have a WCL slug that doesn't derive mechanically from the display name;
// if a character never resolves, check their WCL profile URL for the
// actual slug.
export function toServerSlug(realm: string): string {
  return realm
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ZoneRankings {
  bestPerformanceAverage: number | null;
  medianPerformanceAverage: number | null;
  rankings: { totalKills: number }[] | null;
}

const ZONE_RANKINGS_QUERY = `
query($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $partition: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      zoneRankings(zoneID: $zoneID, partition: $partition, metric: dps)
    }
  }
}`;

interface CharacterZoneRankingsData {
  characterData: {
    character: { zoneRankings: ZoneRankings | null } | null;
  };
}

// getCharacterZoneRankings returns:
//   - null if WCL doesn't know this name/realm/region combination at all
//   - a ZoneRankings with bestPerformanceAverage === null if the character
//     is known but has no logs for this specific zone/partition (verified
//     live: WCL returns an object with all-null fields here, not a JSON
//     null -- see hasData())
//   - a ZoneRankings with real data otherwise
export async function getCharacterZoneRankings(
  name: string,
  serverSlug: string,
  serverRegion: string,
  zoneID: number,
  partition: number
): Promise<ZoneRankings | null> {
  const data = await wclGraphQL<CharacterZoneRankingsData>(ZONE_RANKINGS_QUERY, {
    name,
    serverSlug,
    serverRegion,
    zoneID,
    partition,
  });
  return data.characterData.character?.zoneRankings ?? null;
}

export function hasData(zr: ZoneRankings | null): zr is ZoneRankings & { bestPerformanceAverage: number } {
  return zr !== null && zr.bestPerformanceAverage !== null;
}

export function runsEstimate(zr: ZoneRankings): number {
  if (!zr.rankings) return 0;
  return zr.rankings.reduce((sum, r) => sum + (r.totalKills ?? 0), 0);
}
