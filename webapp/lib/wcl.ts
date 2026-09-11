// lib/wcl.ts
//
// WarcraftLogs API v2 client -- client-credentials flow only.
//
// Runs entirely in the browser (static export, no server -- see
// next.config.mjs's output: "export" and the GitHub Pages workflow). This
// works because WCL's OAuth token endpoint and GraphQL endpoint both send
// permissive CORS headers (confirmed live: `Access-Control-Allow-Origin`
// echoes the requesting origin on both), so a direct browser fetch is fine
// -- no proxy needed. The user enters their own WCL API client's
// credentials once (stored in IndexedDB, see lib/credentials.ts), and this
// module takes them as parameters rather than reading any server env var
// (there is no server). No per-user *login*: confirmed live (two different
// WCL accounts, same registered client) that WCL's rate limit is tracked
// per API client, not per logged-in user -- so an OAuth login screen
// wouldn't give separate quotas anyway, just extra complexity. Entering
// your own Client ID/Secret is a different thing: it's how you supply your
// own quota budget without it being hardcoded at build time. Since this
// runs in the user's own browser, their own Basic-Auth credentials being
// visible in their own network tab is not an exposure to anyone else.

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_ENDPOINT = "https://www.warcraftlogs.com/api/v2/client";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Keyed by clientId: this server process may see more than one WCL client
// over its lifetime (credentials changed via the UI), so a single
// module-level token no longer applies -- still fine to keep in memory,
// this remains a single-instance personal deployment.
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  // btoa, not Buffer -- this module runs in the browser, no Node runtime.
  const basicAuth = "Basic " + btoa(`${clientId}:${clientSecret}`);
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
    // Left in English regardless of UI locale -- a raw diagnostic (HTTP
    // status + WCL's own response body), not chrome text worth translating.
    throw new Error(`WCL token request failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const token = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  tokenCache.set(clientId, token);
  return token.accessToken;
}

// Used by the onboarding screen to check a freshly-entered Client ID/Secret
// pair before saving it -- just the OAuth token exchange, same endpoint
// getAccessToken uses. Costs nothing against the WCL "points" budget (that
// quota only applies to GraphQL queries, not the token endpoint). Throws on
// an invalid pair; always bypasses the cache so a stale entry for the same
// clientId (e.g. a previously-valid secret that got revoked) can't mask a
// real failure.
export async function validateCredentials(clientId: string, clientSecret: string): Promise<void> {
  tokenCache.delete(clientId);
  await getAccessToken(clientId, clientSecret);
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function wclGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  clientId: string,
  clientSecret: string
): Promise<T> {
  const accessToken = await getAccessToken(clientId, clientSecret);

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

export type Role = "tank" | "healer" | "dps";

// Blizzard's official numeric specialization IDs -> role. Stable across
// expansions, used throughout Blizzard's own API/addon ecosystem. Read from
// gameData.global.active_spec.id (Blizzard's own cached data, numeric --
// NOT the .name, which is localized the same way character_class.name is).
export const ROLE_BY_SPEC_ID: Record<number, Role> = {
  73: "tank", // Warrior - Protection
  71: "dps", // Warrior - Arms
  72: "dps", // Warrior - Fury
  65: "healer", // Paladin - Holy
  66: "tank", // Paladin - Protection
  70: "dps", // Paladin - Retribution
  253: "dps", // Hunter - Beast Mastery
  254: "dps", // Hunter - Marksmanship
  255: "dps", // Hunter - Survival
  259: "dps", // Rogue - Assassination
  260: "dps", // Rogue - Outlaw
  261: "dps", // Rogue - Subtlety
  256: "healer", // Priest - Discipline
  257: "healer", // Priest - Holy
  258: "dps", // Priest - Shadow
  250: "tank", // Death Knight - Blood
  251: "dps", // Death Knight - Frost
  252: "dps", // Death Knight - Unholy
  262: "dps", // Shaman - Elemental
  263: "dps", // Shaman - Enhancement
  264: "healer", // Shaman - Restoration
  62: "dps", // Mage - Arcane
  63: "dps", // Mage - Fire
  64: "dps", // Mage - Frost
  265: "dps", // Warlock - Affliction
  266: "dps", // Warlock - Demonology
  267: "dps", // Warlock - Destruction
  268: "tank", // Monk - Brewmaster
  269: "dps", // Monk - Windwalker
  270: "healer", // Monk - Mistweaver
  102: "dps", // Druid - Balance
  103: "dps", // Druid - Feral
  104: "tank", // Druid - Guardian
  105: "healer", // Druid - Restoration
  577: "dps", // Demon Hunter - Havoc
  581: "tank", // Demon Hunter - Vengeance
  1467: "dps", // Evoker - Devastation
  1468: "healer", // Evoker - Preservation
  1473: "dps", // Evoker - Augmentation
};

export interface CharacterProfile {
  zoneRankings: ZoneRankings | null;
  // Blizzard's official numeric class ID (see CLASS_BY_ID), or null if WCL
  // hasn't cached Blizzard game data for this character. Deliberately not
  // WCL's own `classID` field -- that uses WCL's internal numbering
  // (verified live: classID 1 for a real Death Knight, not Blizzard's
  // official ID 6).
  classId: number | null;
  // Current role, derived from Blizzard's own active_spec.id (see
  // ROLE_BY_SPEC_ID), or null if unknown/unrecognized.
  role: Role | null;
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

interface ParsedGameData {
  global?: {
    character_class?: { id?: number };
    active_spec?: { id?: number };
  };
}

function extractClassId(gameData: unknown): number | null {
  if (!gameData || typeof gameData !== "object") {
    return null;
  }
  return (gameData as ParsedGameData).global?.character_class?.id ?? null;
}

function extractRole(gameData: unknown): Role | null {
  if (!gameData || typeof gameData !== "object") {
    return null;
  }
  const specId = (gameData as ParsedGameData).global?.active_spec?.id;
  if (specId === undefined) return null;
  return ROLE_BY_SPEC_ID[specId] ?? null;
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
  partition: number,
  clientId: string,
  clientSecret: string
): Promise<CharacterProfile | null> {
  const data = await wclGraphQL<RawCharacterProfileData>(
    CHARACTER_PROFILE_QUERY,
    { name, serverSlug, serverRegion, zoneID, partition },
    clientId,
    clientSecret
  );
  const char = data.characterData.character;
  if (!char) {
    return null;
  }
  return {
    zoneRankings: char.zoneRankings,
    classId: extractClassId(char.gameData),
    role: extractRole(char.gameData),
  };
}

export function hasData(zr: ZoneRankings | null): zr is ZoneRankings & { bestPerformanceAverage: number } {
  return zr !== null && zr.bestPerformanceAverage !== null;
}

export function runsEstimate(zr: ZoneRankings): number {
  if (!zr.rankings) return 0;
  return zr.rankings.reduce((sum, r) => sum + (r.totalKills ?? 0), 0);
}
