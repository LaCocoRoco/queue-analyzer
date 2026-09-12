// lib/rio.ts
//
// raider.io public API client. Like lib/wcl.ts, this runs directly in the
// browser -- confirmed live that raider.io's v1 API sends permissive CORS
// headers (Access-Control-Allow-Origin echoes the requesting origin) on
// both the preflight and the actual response, same as WCL. No API key
// needed for this endpoint (unauthenticated requests are capped at 200/min
// per raider.io's docs, far more than a Group Finder batch needs).

const API_BASE = "https://raider.io/api/v1/characters/profile";

export interface RioProfile {
  // Overall Mythic+ score for the current season (mythic_plus_scores_by_season[0].scores.all).
  // Not split by role here -- callers that only care about DPS should keep
  // filtering by WCL role like lookup.ts already does; raider.io's own
  // role-specific scores (scores.dps/healer/tank) are usually 0 for
  // whichever roles a character didn't actually play this season, which
  // would be misleading to read as "this DPS's tank score is 0".
  score: number;
  // gear.item_level_equipped, not item_level_total -- "your current ilvl"
  // conventionally means what's equipped, and total has been unreliable
  // in live testing (frequently 0 even when equipped is populated).
  itemLevel: number;
  // raider.io computes and returns its own color for the score directly
  // (mythic_plus_scores_by_season[0].segments.all.color) -- confirmed live,
  // a smooth gradient (grey -> green -> blue -> purple -> orange as score
  // rises) rather than fixed tiers like WCL's. No need to reverse-engineer
  // thresholds ourselves; just use what they hand back.
  color: string;
}

// Returns null if raider.io doesn't know this character (own realm/name
// slugging is lenient enough that lib/wcl.ts's toServerSlug works fine
// here too -- confirmed live against a realm with an apostrophe) or on any
// other error. Never throws -- a missing raider.io profile shouldn't fail
// the whole lookup, same philosophy as the WCL side.
export async function getRioProfile(name: string, realmSlug: string, region: string): Promise<RioProfile | null> {
  const url = `${API_BASE}?region=${encodeURIComponent(region.toLowerCase())}&realm=${encodeURIComponent(realmSlug)}&name=${encodeURIComponent(name)}&fields=mythic_plus_scores_by_season:current,gear`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    const score = data?.mythic_plus_scores_by_season?.[0]?.scores?.all ?? 0;
    const itemLevel = data?.gear?.item_level_equipped ?? 0;
    const color = data?.mythic_plus_scores_by_season?.[0]?.segments?.all?.color ?? "#9d9d9d";
    return { score, itemLevel, color };
  } catch {
    return null;
  }
}
