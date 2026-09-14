// lib/rioTier.ts
//
// Spec-strength "Tier" grade (S/A/B/C), derived from raider.io's public
// cutoff-analysis endpoint -- confirmed live to exist, be CORS-open, and
// carry per-spec score cutoffs at several population percentiles, even
// though it isn't listed anywhere in raider.io's own docs page (found via
// its OpenAPI spec at raider.io/swagger.json instead). This is a DIFFERENT
// thing from a character's own WCL Log percentile (see lib/lookup.ts's
// `best`): that measures how good THIS applicant plays their spec; this
// measures how strong the SPEC ITSELF currently is relative to every other
// spec, regardless of who's playing it -- e.g. a mediocre player of a
// top-tier spec can still show S here. Shown as a separate column/readout
// specifically so the two aren't conflated, and NOT factored into ranking
// (per explicit request -- this is informational only).

const RIO_API_BASE = "https://raider.io/api/v1";

// Bumped once per expansion (rarely -- see static-data's own documented
// enum: 11 = Midnight, 10 = TheWarWithin, 9 = Dragonflight, ...). Seasons
// WITHIN an expansion (e.g. season-mn-1 -> season-mn-2) need no manual bump
// at all -- resolveCurrentSeason below picks the currently-active one
// automatically from this expansion's own season list.
const RIO_EXPANSION_ID = 11;

// Used only if live season detection fails outright (network error,
// unexpected response shape) -- keeps the tier feature degrading to "no
// grades shown" rather than crashing, same philosophy as getCurrentSeason's
// fallback in lib/wcl.ts. Update this if it ever goes stale AND detection
// is also broken; otherwise it's dead code that just never gets hit.
const FALLBACK_SEASON = "season-mn-2";

export type TierGrade = "S" | "A" | "B" | "C";

// S = orange, A = red, B = blue, C = grey -- explicitly requested to be its
// own palette, distinct from the orange/purple/blue/green/grey WCL
// percentile tiers used elsewhere (rankColor/percentileColor), so a Tier
// grade is never visually confused with a Log percentile despite both being
// letter/number "how good" indicators.
export const TIER_COLOR: Record<TierGrade, string> = {
  S: "#FF8000",
  A: "#FF3333",
  B: "#0070DD",
  C: "#9D9D9D",
};

interface RawSeason {
  slug: string;
  is_main_season: boolean;
  starts: Record<string, string>;
}

interface RawStaticData {
  seasons: RawSeason[];
}

interface RawCutoffPercentile {
  percentile: number;
  cutoffScore: number;
}

interface RawCutoffCohort {
  semantics: string;
  specId: number;
  percentiles: RawCutoffPercentile[];
}

interface RawCutoffAnalysis {
  cohorts: RawCutoffCohort[];
}

let cachedSeasonPromise: Promise<string> | null = null;

// Picks the main season with the most recent start date that's already
// started -- robust against an "ends" date that's just a far-future
// placeholder for a still-open season (confirmed live: TWW3's cutoffs
// season had one), unlike checking "starts <= now <= ends" which would've
// worked too but needlessly depends on "ends" being accurate.
async function resolveCurrentSeason(): Promise<string> {
  const res = await fetch(`${RIO_API_BASE}/mythic-plus/static-data?expansion_id=${RIO_EXPANSION_ID}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`raider.io static-data request failed (${res.status})`);
  }
  const data = (await res.json()) as RawStaticData;
  const now = Date.now();
  const mainSeasons = data.seasons
    .filter((s) => s.is_main_season && new Date(s.starts.us ?? s.starts.eu).getTime() <= now)
    .sort((a, b) => new Date(b.starts.us ?? b.starts.eu).getTime() - new Date(a.starts.us ?? a.starts.eu).getTime());
  if (mainSeasons.length === 0) {
    throw new Error("No active raider.io main season found");
  }
  return mainSeasons[0].slug;
}

function getCurrentSeasonSlug(): Promise<string> {
  if (!cachedSeasonPromise) {
    cachedSeasonPromise = resolveCurrentSeason().catch(() => FALLBACK_SEASON);
  }
  return cachedSeasonPromise;
}

// specId -> grade, cached for the lifetime of the page load (one fetch per
// full page load/reload, not per Import -- explicitly requested; re-fetching
// on every Import would just hammer raider.io for data that doesn't change
// that often). Promise-cached (not value-cached after the fact) so two
// Imports firing close together before the first fetch resolves still only
// trigger one request.
let cachedTierPromise: Promise<Map<number, TierGrade>> | null = null;

function grade(norm: number): TierGrade {
  if (norm <= 25) return "C";
  if (norm <= 50) return "B";
  if (norm <= 75) return "A";
  return "S";
}

// Population percentile used as the basis for the comparison -- confirmed
// live and agreed on with real numbers pulled from this exact endpoint (see
// project history): P1 (top 1% of each spec's population) is granular
// enough to be stable (unlike P0.1, whose tiny per-spec sample sizes made
// rankings jump around) while still reflecting high-end play.
const TIER_PERCENTILE = 1;

async function fetchSpecTiers(region: string): Promise<Map<number, TierGrade>> {
  const season = await getCurrentSeasonSlug();
  const url = `${RIO_API_BASE}/mythic-plus/cutoff-analysis?season=${encodeURIComponent(season)}&region=${encodeURIComponent(region.toLowerCase())}&category=specs&percentile=${TIER_PERCENTILE}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`raider.io cutoff-analysis request failed (${res.status})`);
  }
  const data = (await res.json()) as RawCutoffAnalysis;

  const bySpec = new Map<number, number>();
  for (const cohort of data.cohorts) {
    if (cohort.semantics !== "spec") continue;
    const p = cohort.percentiles.find((p) => p.percentile === TIER_PERCENTILE);
    if (p) bySpec.set(cohort.specId, p.cutoffScore);
  }

  // Normalized GLOBALLY across every spec of every role together (not
  // per-role) -- explicitly requested: since tanks/healers post
  // structurally higher scores than DPS at the same percentile, a
  // per-role normalization would've let a middling tank/healer spec always
  // land in the top bracket. Global min/max means role itself becomes part
  // of the signal instead of being normalized away.
  const values = [...bySpec.values()];
  if (values.length === 0) {
    return new Map();
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);

  const result = new Map<number, TierGrade>();
  for (const [specId, score] of bySpec) {
    const norm = hi > lo ? ((score - lo) / (hi - lo)) * 100 : 100;
    result.set(specId, grade(norm));
  }
  return result;
}

// Never throws -- a raider.io outage or format change should degrade to "no
// Tier grades shown", not break the whole lookup, same philosophy as
// getRioProfile in lib/rio.ts.
export function getSpecTiers(region: string): Promise<Map<number, TierGrade>> {
  if (!cachedTierPromise) {
    cachedTierPromise = fetchSpecTiers(region).catch(() => new Map<number, TierGrade>());
  }
  return cachedTierPromise;
}
