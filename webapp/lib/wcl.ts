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

// A specific dungeon's own raw-throughput percentile (Dungeon mode), as
// opposed to ZoneRankings' whole-season points-based score (Season mode).
// Needs its OWN query (see ENCOUNTER_PROFILE_QUERY) -- this is NOT the same
// number as ZoneRankings' embedded per-encounter breakdown, confirmed live
// against a real character's WCL page (that embedded data read 13 where the
// site's own per-dungeon detail page showed 37.1). The critical piece is
// byBracket: true -- without it, WCL compares a run against ALL logs of
// that dungeon regardless of keystone level, which reads much lower than
// what the site actually displays; byBracket compares each run only within
// its own key-level bracket first, then blends those -- confirmed live,
// exact match (37.08 vs the site's displayed 37.1) on medianPerformance,
// bestAmount, totalKills, and fastestKill all at once.
export interface EncounterRanking {
  bestAmount: number | null;
  medianPerformance: number | null;
  averagePerformance: number | null;
  totalKills: number;
  fastestKill: number | null;
}

const FALLBACK_ZONE_ID = Number(process.env.NEXT_PUBLIC_WCL_ZONE_ID);
const FALLBACK_PARTITION = Number(process.env.NEXT_PUBLIC_WCL_PARTITION);

export interface SeasonInfo {
  zoneID: number;
  partition: number;
  // Dungeon name (WCL's own spelling, lowercased) -> encounter ID, for the
  // currently detected Mythic+ season zone. Empty if detection fell back to
  // the hardcoded env vars below -- Dungeon-mode lookups just degrade to
  // "no encounter match -> season-wide data" in that case (see
  // lib/lookup.ts), never wrong data.
  encountersByName: Map<string, number>;
}

let cachedSeason: SeasonInfo | null = null;

// Confirmed against WCL's own v2 schema docs (warcraftlogs.com/v2-api-docs):
// Zone.frozen is permanently true once a zone's data can no longer change
// (i.e. every past tier), so filtering to frozen: false alone narrows
// "every zone from every expansion WCL has ever tracked" down to just the
// small handful currently live. Zone.brackets.type further narrows to
// specifically the Mythic+ one ("Keystone Level" brackets, confirmed live).
// Zone.partitions[].default identifies the current partition within that
// zone without needing to know its ID ahead of time. Together this is what
// makes the zoneID/partition pair -- and the dungeon-name/encounterID map
// alongside it -- self-updating across season transitions with no code
// change needed, which is the whole point: this keeps working even if
// nobody is around to bump NEXT_PUBLIC_WCL_ZONE_ID by hand next season.
const CURRENT_SEASON_QUERY = `
query {
  worldData {
    zones {
      id
      frozen
      brackets { type }
      partitions { id default }
      encounters { id name }
    }
  }
}`;

interface RawZone {
  id: number;
  frozen: boolean;
  brackets: { type: string | null } | null;
  partitions: { id: number; default: boolean }[] | null;
  encounters: { id: number; name: string }[] | null;
}

interface RawSeasonData {
  worldData: { zones: RawZone[] };
}

// Never throws -- resolves to an empty array on any failure, so
// getCurrentSeason's own find()-then-fallback logic just naturally finds
// nothing and degrades gracefully, same as before.
let cachedZonesPromise: Promise<RawZone[]> | null = null;
function getZones(clientId: string, clientSecret: string): Promise<RawZone[]> {
  if (!cachedZonesPromise) {
    cachedZonesPromise = wclGraphQL<RawSeasonData>(CURRENT_SEASON_QUERY, {}, clientId, clientSecret)
      .then((data) => data.worldData.zones)
      .catch(() => []);
  }
  return cachedZonesPromise;
}

// Resolves the current Mythic+ season's zoneID/partition and its
// dungeon-name -> encounterID map automatically (see CURRENT_SEASON_QUERY
// above). Falls back to NEXT_PUBLIC_WCL_ZONE_ID/PARTITION (with an empty
// encounter map) if detection fails for any reason -- a WCL outage or an
// unexpected API change should never hard-break the whole app over this.
// Cached for the lifetime of the page load (zones don't change mid-session).
export async function getCurrentSeason(clientId: string, clientSecret: string): Promise<SeasonInfo> {
  if (cachedSeason) {
    return cachedSeason;
  }
  const zones = await getZones(clientId, clientSecret);
  const mplusZone = zones.find((z) => !z.frozen && (z.brackets?.type ?? "").toLowerCase().includes("keystone"));
  const defaultPartition = mplusZone?.partitions?.find((p) => p.default)?.id;
  if (mplusZone && defaultPartition != null) {
    cachedSeason = {
      zoneID: mplusZone.id,
      partition: defaultPartition,
      encountersByName: new Map((mplusZone.encounters ?? []).map((e) => [e.name.toLowerCase(), e.id])),
    };
    return cachedSeason;
  }
  cachedSeason = { zoneID: FALLBACK_ZONE_ID, partition: FALLBACK_PARTITION, encountersByName: new Map() };
  return cachedSeason;
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

// Blizzard's official numeric specialization ID -> Blizzard's official
// numeric class ID (CLASS_BY_ID's keys) -- every spec belongs to exactly
// one class, so this is a pure, stable lookup, same grouping as
// ROLE_BY_SPEC_ID above. Lets lookupOne (lib/lookup.ts) derive classId
// straight from the addon's own live specID export instead of waiting on
// (or accepting gaps in) WCL's gameData -- same reasoning as specId/role
// already get from the addon, applied to the class-color table column too.
export const CLASS_ID_BY_SPEC_ID: Record<number, number> = {
  71: 1, // Warrior - Arms
  72: 1, // Warrior - Fury
  73: 1, // Warrior - Protection
  65: 2, // Paladin - Holy
  66: 2, // Paladin - Protection
  70: 2, // Paladin - Retribution
  253: 3, // Hunter - Beast Mastery
  254: 3, // Hunter - Marksmanship
  255: 3, // Hunter - Survival
  259: 4, // Rogue - Assassination
  260: 4, // Rogue - Outlaw
  261: 4, // Rogue - Subtlety
  256: 5, // Priest - Discipline
  257: 5, // Priest - Holy
  258: 5, // Priest - Shadow
  250: 6, // Death Knight - Blood
  251: 6, // Death Knight - Frost
  252: 6, // Death Knight - Unholy
  262: 7, // Shaman - Elemental
  263: 7, // Shaman - Enhancement
  264: 7, // Shaman - Restoration
  62: 8, // Mage - Arcane
  63: 8, // Mage - Fire
  64: 8, // Mage - Frost
  265: 9, // Warlock - Affliction
  266: 9, // Warlock - Demonology
  267: 9, // Warlock - Destruction
  268: 10, // Monk - Brewmaster
  269: 10, // Monk - Windwalker
  270: 10, // Monk - Mistweaver
  102: 11, // Druid - Balance
  103: 11, // Druid - Feral
  104: 11, // Druid - Guardian
  105: 11, // Druid - Restoration
  577: 12, // Demon Hunter - Havoc
  581: 12, // Demon Hunter - Vengeance
  1467: 13, // Evoker - Devastation
  1468: 13, // Evoker - Preservation
  1473: 13, // Evoker - Augmentation
};

export interface CharacterProfile {
  zoneRankings: ZoneRankings | null;
  // Only present when a dungeon-specific lookup was requested (encounterID
  // given -- see getCharacterProfile) and the character has logs for it.
  encounterRankings: EncounterRanking | null;
  // Blizzard's official numeric class ID (see CLASS_BY_ID), or null if WCL
  // hasn't cached Blizzard game data for this character. Deliberately not
  // WCL's own `classID` field -- that uses WCL's internal numbering
  // (verified live: classID 1 for a real Death Knight, not Blizzard's
  // official ID 6).
  classId: number | null;
  // Current role, derived from Blizzard's own active_spec.id (see
  // ROLE_BY_SPEC_ID), or null if unknown/unrecognized.
  role: Role | null;
  // Blizzard's own numeric spec ID (active_spec.id itself), or null if
  // unknown -- see extractSpecId's comment for why this is kept separately
  // from role.
  specId: number | null;
}

// metric: points_and_damage for DPS and tanks, points_and_healing for
// healers -- confirmed live (real character, real key runs) against WCL's
// own character page: bestPerformanceAverage matches the site's season-wide
// "Best DPS % Avg" exactly for points_and_damage. Every role gets a Log
// value now (tanks/healers are no longer excluded -- see lib/lookup.ts's
// lookupOne), just not ranked against the DPS pool. $metric is a variable
// (not hardcoded) specifically so getCharacterProfile can pick the
// role-appropriate one.
//
// gameData is WCL's cached copy of Blizzard's own character profile API
// response. forceUpdate: true (WCL will go fetch a live copy from Blizzard
// instead of only returning an existing cache) DOES fix the case where
// classId/specId come back null for a character WCL hasn't independently
// cached yet -- confirmed live -- but also confirmed live to make every
// single lookup noticeably slower (a real outbound Blizzard round-trip per
// character instead of a DB read), which isn't worth it for a batch of a
// few dozen applicants. Left off (the default, equivalent to
// forceUpdate: false) -- classId/specId/tier just stay null for whichever
// characters WCL hasn't already cached on its own, same tradeoff as before.
const CHARACTER_PROFILE_QUERY = `
query($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $partition: Int!, $metric: CharacterPageRankingMetricType!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      gameData
      zoneRankings(zoneID: $zoneID, partition: $partition, metric: $metric)
    }
  }
}`;

// Dungeon-specific query (Dungeon mode) -- see EncounterRanking's comment
// for why this needs its own request and its own metric/byBracket
// combination, rather than reusing anything from the season query above.
// metric: dps for DPS/tanks, hps for healers -- same role split as the
// season query, just using encounterRankings' own metric enum (dps/hps
// instead of points_and_damage/points_and_healing, which aren't valid
// here -- confirmed live).
const ENCOUNTER_PROFILE_QUERY = `
query($name: String!, $serverSlug: String!, $serverRegion: String!, $encounterID: Int!, $partition: Int!, $metric: CharacterRankingMetricType!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encounterID, partition: $partition, metric: $metric, byBracket: true)
    }
  }
}`;

interface RawCharacterProfileData {
  characterData: {
    character: { gameData: unknown; zoneRankings: ZoneRankings | null } | null;
  };
}

interface RawEncounterProfileData {
  characterData: {
    character: { encounterRankings: EncounterRanking | null } | null;
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

// Blizzard's numeric spec ID itself (not just the tank/healer/dps role it
// maps to via ROLE_BY_SPEC_ID) -- needed separately to look up a spec's
// RaiderIO tier grade later (see lib/rioTier.ts), which is specific to e.g.
// "Blood Death Knight" vs. "Frost Death Knight", not just "this is a tank".
function extractSpecId(gameData: unknown): number | null {
  if (!gameData || typeof gameData !== "object") {
    return null;
  }
  return (gameData as ParsedGameData).global?.active_spec?.id ?? null;
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
  clientSecret: string,
  // When given, also fetches this dungeon's own encounterRankings
  // alongside the season-wide zoneRankings (both fetched together, always,
  // regardless of which mode the UI is currently in -- see LookupResult's
  // comment in lib/lookup.ts for why).
  encounterID?: number,
  // Healers get points_and_healing instead of points_and_damage --
  // everyone else (dps, tank, or unknown) gets the damage-based metric,
  // since a tank's Log value is still meant to reflect damage output, just
  // without being ranked against the DPS pool (see lib/lookup.ts).
  role?: Role | null
): Promise<CharacterProfile | null> {
  const seasonMetric = role === "healer" ? "points_and_healing" : "points_and_damage";
  const encounterMetric = role === "healer" ? "hps" : "dps";
  const [seasonData, encounterData] = await Promise.all([
    wclGraphQL<RawCharacterProfileData>(
      CHARACTER_PROFILE_QUERY,
      { name, serverSlug, serverRegion, zoneID, partition, metric: seasonMetric },
      clientId,
      clientSecret
    ),
    encounterID != null
      ? wclGraphQL<RawEncounterProfileData>(
          ENCOUNTER_PROFILE_QUERY,
          { name, serverSlug, serverRegion, encounterID, partition, metric: encounterMetric },
          clientId,
          clientSecret
        )
      : Promise.resolve(null),
  ]);
  const char = seasonData.characterData.character;
  if (!char) {
    return null;
  }
  return {
    zoneRankings: char.zoneRankings,
    encounterRankings: encounterData?.characterData.character?.encounterRankings ?? null,
    classId: extractClassId(char.gameData),
    role: extractRole(char.gameData),
    specId: extractSpecId(char.gameData),
  };
}

export function hasData(zr: ZoneRankings | null): zr is ZoneRankings & { bestPerformanceAverage: number } {
  return zr !== null && zr.bestPerformanceAverage !== null;
}

export function runsEstimate(zr: ZoneRankings): number {
  if (!zr.rankings) return 0;
  return zr.rankings.reduce((sum, r) => sum + (r.totalKills ?? 0), 0);
}
