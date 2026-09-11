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

// Standard WoW class colors (RAID_CLASS_COLORS), keyed by Blizzard's
// official numeric class ID -- NOT by name. gameData.global.character_class
// is Blizzard's own data, but its .name is localized to whatever locale WCL
// cached it under (confirmed live: a German character came back with
// "Druide", not "Druid" -- silently failing a name-keyed lookup). The
// numeric .id is locale-independent and stable.
export const CLASS_BY_ID: Record<number, { name: string; color: string }> = {
  1: { name: "Warrior", color: "#C69B6D" },
  2: { name: "Paladin", color: "#F58CBA" },
  3: { name: "Hunter", color: "#AAD372" },
  4: { name: "Rogue", color: "#FFF468" },
  5: { name: "Priest", color: "#FFFFFF" },
  6: { name: "Death Knight", color: "#C41F3B" },
  7: { name: "Shaman", color: "#0070DD" },
  8: { name: "Mage", color: "#3FC7EB" },
  9: { name: "Warlock", color: "#8788EE" },
  10: { name: "Monk", color: "#00FF98" },
  11: { name: "Druid", color: "#FF7C0A" },
  12: { name: "Demon Hunter", color: "#A330C9" },
  13: { name: "Evoker", color: "#33937F" },
};

export interface ZoneRankings {
  bestPerformanceAverage: number | null;
  medianPerformanceAverage: number | null;
  rankings: { totalKills: number }[] | null;
}

export interface CharacterProfile {
  zoneRankings: ZoneRankings | null;
  // Blizzard's official numeric class ID (see CLASS_BY_ID), or null if WCL
  // hasn't cached Blizzard game data for this character. Deliberately not
  // WCL's own `classID` field -- that uses WCL's internal numbering
  // (verified live: classID 1 for a real Death Knight, not Blizzard's
  // official ID 6).
  classId: number | null;
}

// metric: playerscore (WCL's default M+ ranking metric -- a composite score
// per run, NOT raw damage-per-second) is what the character page's default
// landing view ("Points" tab) and its "Best/Median DPS % Avg" labels
// actually show. Confirmed live against a real character: metric: dps gave
// wrong numbers (7.8/5.76 and a Runs undercount from a different
// totalKills breakdown), metric: playerscore matched the website exactly
// (17.49/12.05, and totalKills summing to exactly the displayed Runs
// count). "default" resolves to the same thing server-side; playerscore is
// used explicitly here to be unambiguous.
//
// gameData is WCL's cached copy of Blizzard's own character profile API
// response (no extra live Blizzard call -- same cost as the rest of this
// query); we only need character_class.name out of it.
const CHARACTER_PROFILE_QUERY = `
query($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $partition: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      gameData
      zoneRankings(zoneID: $zoneID, partition: $partition, metric: playerscore)
    }
  }
}`;

interface RawCharacterProfileData {
  characterData: {
    character: { gameData: unknown; zoneRankings: ZoneRankings | null } | null;
  };
}

function extractClassId(gameData: unknown): number | null {
  if (!gameData || typeof gameData !== "object") {
    return null;
  }
  const g = gameData as { global?: { character_class?: { id?: number } } };
  return g.global?.character_class?.id ?? null;
}

// getCharacterProfile returns:
//   - null if WCL doesn't know this name/realm/region combination at all
//   - a profile with zoneRankings.bestPerformanceAverage === null if the
//     character is known but has no logs for this specific zone/partition
//     (verified live: WCL returns an object with all-null fields here, not
//     a JSON null -- see hasData())
//   - a profile with real zoneRankings data otherwise
// classId is populated independently of zoneRankings whenever WCL has
// cached game data for the character.
export async function getCharacterProfile(
  name: string,
  serverSlug: string,
  serverRegion: string,
  zoneID: number,
  partition: number
): Promise<CharacterProfile | null> {
  const data = await wclGraphQL<RawCharacterProfileData>(CHARACTER_PROFILE_QUERY, {
    name,
    serverSlug,
    serverRegion,
    zoneID,
    partition,
  });
  const char = data.characterData.character;
  if (!char) {
    return null;
  }
  return {
    zoneRankings: char.zoneRankings,
    classId: extractClassId(char.gameData),
  };
}

export function hasData(zr: ZoneRankings | null): zr is ZoneRankings & { bestPerformanceAverage: number } {
  return zr !== null && zr.bestPerformanceAverage !== null;
}

export function runsEstimate(zr: ZoneRankings): number {
  if (!zr.rankings) return 0;
  return zr.rankings.reduce((sum, r) => sum + (r.totalKills ?? 0), 0);
}
