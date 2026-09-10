// lib/wcl.ts
//
// WarcraftLogs API v2 OAuth (Authorization Code flow) + GraphQL client.
//
// NOT independently verified end-to-end -- this environment has no way to
// click through a real browser OAuth consent screen. Everything here is
// built from WCL's documented OAuth endpoints (confirmed: authorize_uri
// https://www.warcraftlogs.com/oauth/authorize, token_uri
// https://www.warcraftlogs.com/oauth/token -- both same as the previously
// working client-credentials flow) plus the GraphQL query shape we already
// verified live against the client-credentials flow (see git history of
// the deleted Go tool). The one open question: WCL's docs mention a
// separate "/api/v2/user" endpoint for user-authorized tokens (as opposed
// to "/api/v2/client" for client-credentials tokens) -- WCL_API_ENDPOINT
// below defaults to that, but flip it via env var if the first real login
// shows otherwise (see webapp/README.md).

const AUTHORIZE_URL = "https://www.warcraftlogs.com/oauth/authorize";
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";

const CLIENT_ID = process.env.WCL_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.WCL_REDIRECT_URI ?? "";
const API_ENDPOINT = process.env.WCL_API_ENDPOINT ?? "https://www.warcraftlogs.com/api/v2/user";

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

function basicAuthHeader(): string {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Token-Austausch fehlgeschlagen (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Token-Refresh fehlgeschlagen (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export async function wclGraphQL<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
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
// apostrophes, everything else collapsed to hyphens). Mirrors the same
// logic used by the addon/tool before this rewrite. A handful of realms
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
//     live against the client-credentials flow: WCL returns an object with
//     all-null fields here, not a JSON null -- see hasData())
//   - a ZoneRankings with real data otherwise
export async function getCharacterZoneRankings(
  accessToken: string,
  name: string,
  serverSlug: string,
  serverRegion: string,
  zoneID: number,
  partition: number
): Promise<ZoneRankings | null> {
  const data = await wclGraphQL<CharacterZoneRankingsData>(accessToken, ZONE_RANKINGS_QUERY, {
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
