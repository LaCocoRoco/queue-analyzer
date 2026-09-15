"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { clearCredentials, loadCredentials, saveCredentials, type WclCredentials } from "@/lib/credentials";
import { detectLocale, DICTS, DEFAULT_LOCALE } from "@/lib/i18n";
import {
  EXPECTED_ADDON_VERSION,
  fetchRioScores,
  LookupError,
  parseClipboardText,
  REGION,
  runLookup,
  withEffectiveMode,
  withRanks,
  type LookupResult,
  type RankedResult,
} from "@/lib/lookup";
import { toServerSlug, validateCredentials } from "@/lib/wcl";
import { TIER_COLOR } from "@/lib/rioTier";

// Flat ":"-delimited
// "Name-Realm:Best:Rank:Tier:Name-Realm:Best:Rank:Tier:...:i<version>" -- the
// format the addon's import window parses (see Core.lua's ParseImportText).
// A single line pastes far more reliably into WoW's EditBox than a
// multi-line block. Safe because names/realms never contain ":". Best is
// rounded to a whole number -- no decimals in anything that ends up visible
// in-game. Rank is always present (fixed quadruplets, never fewer) so the
// addon-side parser never has to guess the stride -- it's just 0 when
// Filter wasn't used for this export, which the addon reads as "no rank to
// show". Tier is "-" (never an empty string) when unknown -- an empty field
// would make the addon's ":"-split silently skip it (Lua's gmatch("[^:]+")
// never yields empty captures), shifting every field after it by one and
// corrupting the whole parse. The trailing "i<version>" marker lets the
// addon's ParseImportText tell this string apart from its OWN Export string
// (which is a similar enough shape -- "stuff:Name-Realm:number:number:
// ...e<version>" -- that pasting one into the other used to get silently
// misread as real data instead of rejected), AND lets it check the version
// matches its own -- see EXPECTED_ADDON_VERSION's comment in lib/lookup.ts.
function toExportString(results: RankedResult[]): string {
  const quadruplets = results
    .filter((r) => !r.error)
    .flatMap((r) => [r.key, Math.round(r.best).toString(), r.rank.toString(), r.tier ?? "-"]);
  return [...quadruplets, `i${EXPECTED_ADDON_VERSION}`].join(":");
}

// Standard WoW class colors (RAID_CLASS_COLORS), keyed by Blizzard's
// official numeric class ID -- see lib/wcl.ts's CLASS_BY_ID for why ID and
// not name (gameData's class name is locale-dependent, the ID isn't).
const CLASS_COLORS: Record<number, string> = {
  1: "#C69B6D",
  2: "#F58CBA",
  3: "#AAD372",
  4: "#FFF468",
  5: "#FFFFFF",
  6: "#C41F3B",
  7: "#0070DD",
  8: "#3FC7EB",
  9: "#8788EE",
  10: "#00FF98",
  11: "#FF7C0A",
  12: "#A330C9",
  13: "#33937F",
};

// WCL's own parse-percentile color tiers (orange/purple/blue/green/grey),
// matching the standard WoW item-quality colors those names mirror. Used
// for the LOG value specifically.
function percentileColor(pct: number): string {
  if (pct >= 95) return "#FF8000";
  if (pct >= 75) return "#A335EE";
  if (pct >= 50) return "#0070DD";
  if (pct >= 25) return "#1EFF00";
  return "#9D9D9D";
}

// Keyed by absolute RANK POSITION (1st/2nd/3rd/4th, everything else grey)
// instead of a percentile value -- a deliberately separate function, not a
// reuse of percentileColor, since the two used to look identical in-game
// (rank digits were colored by the LOG percentile) which read as "these two
// numbers are the same thing" when they aren't. Its own palette, not the
// orange/purple/blue/green item-quality one percentileColor uses -- 2nd is
// red, explicitly requested. 0 (unranked -- tanks/healers, see withRanks)
// falls through to grey along with every rank past 4th.
function rankColor(rank: number): string {
  if (rank === 1) return "#FF8000";
  if (rank === 2) return "#FF3333";
  if (rank === 3) return "#0070DD";
  if (rank === 4) return "#1EFF00";
  return "#9D9D9D";
}

// Same character-profile URL WCL's own site uses.
function wclCharacterUrl(name: string, realm: string): string {
  return `https://www.warcraftlogs.com/character/${REGION.toLowerCase()}/${toServerSlug(realm)}/${encodeURIComponent(name)}`;
}

// Zero-padded to 2 digits (#1 -> #01) -- purely cosmetic, requested as a
// quick visual test; ranks past 99 just keep their natural width. 0 (tanks/
// healers -- see withRanks) isn't a real rank at all -- callers show a
// RoleIcon instead for those two roles, and this "-" only as the leftover
// fallback for anything else unranked.
function formatRank(rank: number): string {
  return rank > 0 ? `#${String(rank).padStart(2, "0")}` : "-";
}

// Shield (tank) / cross (healer) glyphs, shown in the Rank column instead of
// the misleading "-" for the two roles withRanks always gives rank 0 (they
// were never in the ranking pool to begin with, so "unranked" reads as
// broken there -- these make it read as "this role doesn't rank" instead).
// `color` is a parameter (not hardcoded) purely so callers can pick, but the
// Rank column itself always passes pure white, matching the original SVGs
// as designed.
function RoleIcon({ role, color, size = 15 }: { role: "tank" | "healer"; color: string; size?: number }) {
  const path =
    role === "tank"
      ? "M 50,26 C 60,26 70,23 70,23 V 46 C 70,62 50,74 50,74 C 50,74 30,62 30,46 V 23 C 30,23 40,26 50,26 Z"
      : "M 42,26 H 58 V 42 H 74 V 58 H 58 V 74 H 42 V 58 H 26 V 42 H 42 Z";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: "block", marginLeft: "auto" }}>
      <circle cx="50" cy="50" r="44" fill="none" stroke={color} strokeWidth={6} />
      <path d={path} fill={color} />
    </svg>
  );
}

// Copies Blizzard's own in-game Mythic+ rating (blizzardScore, sent by the
// addon alongside each name -- see lib/lookup.ts's parseClipboardText)
// into the ioScore/ioColor slot, so the rest of the app (ranking, the IO
// table column) doesn't need to know or care which source it came from.
// Used whenever Filter is on but the RaiderIO toggle isn't -- no network
// request at all, the data was already in the clipboard. raider.io hands
// back its own color directly (see lib/rio.ts); Blizzard's rating has no
// such API-provided color, so this reuses our own Logs-style percentile
// tiers, min-max normalized across the current batch, same technique
// rankResults already uses internally for weighting.
function applyBlizzardScoreAsIo(results: LookupResult[]): LookupResult[] {
  const withScore = results.filter((r) => r.blizzardScore > 0);
  const min = withScore.length ? Math.min(...withScore.map((r) => r.blizzardScore)) : 0;
  const max = withScore.length ? Math.max(...withScore.map((r) => r.blizzardScore)) : 0;

  return results.map((r) => {
    if (r.blizzardScore <= 0) {
      return { ...r, ioScore: 0, ioColor: "#9D9D9D" };
    }
    const norm = max > min ? ((r.blizzardScore - min) / (max - min)) * 100 : 50;
    return { ...r, ioScore: r.blizzardScore, ioColor: percentileColor(norm) };
  });
}

type ButtonState = "idle" | "loading" | "done" | "error";

const BUTTON_COLOR: Record<ButtonState, { bg: string; fg: string }> = {
  idle: { bg: "#3fc7eb", fg: "#0a0a0a" },
  loading: { bg: "#ff8000", fg: "#0a0a0a" },
  done: { bg: "#1eff00", fg: "#0a0a0a" },
  error: { bg: "#ff4d4d", fg: "#fff" },
};

// One of the four stacked button-label spans (see the button's own comment
// for why they're stacked in the first place) -- each needs its own flex
// centering since the shared grid cell they all stretch to fill can be
// taller than a plain text line (the "loading" spinner is the tallest).
function buttonLabelStyle(visible: boolean): CSSProperties {
  return {
    gridArea: "1 / 1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    visibility: visible ? "visible" : "hidden",
  };
}

export default function LookupForm() {
  // Detected once on mount from navigator.languages -- no account/profile to
  // store an explicit preference in, and the default (en, matching SSR/the
  // static prerender) is a fine placeholder until the client-only detection
  // runs.
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const t = DICTS[locale];

  const [credsLoading, setCredsLoading] = useState(true);
  const [creds, setCreds] = useState<WclCredentials | null>(null);

  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Set when handleReadFromClipboard's own upfront credential check (not
  // the onboarding Save button's) fails -- an expired/revoked Client
  // Secret otherwise made every single character's WCL lookup fail
  // independently (each one caught inside lookupOne and reduced to "no
  // data"), which just read as "the Log column is empty" with no
  // indication why. Shown on the onboarding screen after logging the user
  // back out, in the same slot validationError uses for a freshly-typed
  // bad pair.
  const [loggedOutReason, setLoggedOutReason] = useState<string | null>(null);

  const [buttonState, setButtonState] = useState<ButtonState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Distinguishes a WRONG_ADDON_VERSION failure from any other error --
  // unlike other errors (shown generically as just "Error", see the
  // comment near the error-message <p> that used to sit here), this one is
  // actually actionable ("update the addon"), so it gets its own specific
  // button label instead of the generic one.
  const [versionMismatch, setVersionMismatch] = useState(false);

  // Raw (unsorted) results from the last successful lookup -- kept around
  // purely so the Filter/Preview table below can re-rank live as the
  // weight sliders move, without re-querying WCL on every drag.
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  // Off by default: Blizzard's own in-game rating (sent by the addon with
  // every export, no extra request) is the fast default IO source. Turning
  // this on switches to an actual raider.io lookup instead.
  const [raiderIoEnabled, setRaiderIoEnabled] = useState(false);
  // Season (default) uses WCL's whole-season zoneRankings; Dungeon narrows
  // to just the current Keystone dungeon (see Core.lua's
  // GetCurrentDungeonName) via encounterRankings instead -- see
  // runLookup/getCurrentSeason in lib/lookup.ts and lib/wcl.ts.
  const [dungeonMode, setDungeonMode] = useState<"season" | "dungeon">("season");
  const [logsWeight, setLogsWeight] = useState(50);
  const [ioWeight, setIoWeight] = useState(50);

  // "rioLoaded" now means "the IO slot is populated and ready", regardless
  // of source -- raider.io's on-demand "crawl" for a character it hasn't
  // recently cached can take several seconds, so that path is still lazy;
  // Blizzard's rating is already sitting in `results` (from the addon
  // export) and applying it is synchronous, so that path finishes
  // "loading" instantly. Resets to false on every fresh set of results and
  // whenever the RaiderIO toggle itself changes (switching sources needs a
  // fresh pass either way).
  const [rioLoaded, setRioLoaded] = useState(false);
  const [rioLoading, setRioLoading] = useState(false);

  // The addon's raw Export string as last read from the clipboard, kept
  // around purely so "Source" (below) can write it back -- Import
  // immediately overwrites the clipboard with its own computed result,
  // which otherwise loses the original input and makes re-checking what was
  // actually pasted (troubleshooting a weird result) impossible without
  // re-copying from the addon again.
  const [lastSourceText, setLastSourceText] = useState<string | null>(null);

  useEffect(() => {
    setLocale(detectLocale());
    loadCredentials()
      .then(setCreds)
      .catch(() => setCreds(null))
      .finally(() => setCredsLoading(false));
  }, []);

  // Switching the RaiderIO toggle needs a fresh IO pass either way (its own
  // fetch if turned on, or re-deriving from blizzardScore if turned off),
  // so treat it like a new set of results as far as "is the IO slot ready"
  // goes.
  useEffect(() => {
    setRioLoaded(false);
  }, [raiderIoEnabled]);

  // No longer gated on filterEnabled -- the Score column is always shown
  // now (not just while Filter is on), so the IO slot needs to be ready
  // regardless of that toggle.
  useEffect(() => {
    if (!results || rioLoaded || rioLoading) {
      return;
    }
    if (!raiderIoEnabled) {
      setResults(applyBlizzardScoreAsIo(results));
      setRioLoaded(true);
      return;
    }
    setRioLoading(true);
    fetchRioScores(results, REGION)
      .then((updated) => {
        setResults(updated);
        setRioLoaded(true);
      })
      .finally(() => setRioLoading(false));
  }, [raiderIoEnabled, results, rioLoaded, rioLoading]);

  async function handleSaveCredentials() {
    setValidationError(null);
    setLoggedOutReason(null);
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    if (!clientId || !clientSecret) {
      setValidationError(t.validationEmptyError);
      return;
    }

    setValidating(true);
    try {
      await validateCredentials(clientId, clientSecret);
      const newCreds: WclCredentials = { clientId, clientSecret };
      await saveCredentials(newCreds);
      setCreds(newCreds);
    } catch (err) {
      setValidationError((err as Error).message);
    } finally {
      setValidating(false);
    }
  }

  function handleClearResults() {
    setResults(null);
  }

  async function handleCopySource() {
    if (!lastSourceText) return;
    await navigator.clipboard.writeText(lastSourceText);
  }

  async function handleResetCredentials() {
    await clearCredentials();
    setCreds(null);
    setClientIdInput("");
    setClientSecretInput("");
    setLastSourceText(null);
  }

  async function handleReadFromClipboard() {
    if (!creds || buttonState === "loading") return;
    setErrorMessage(null);
    setVersionMismatch(false);

    if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
      setErrorMessage(t.errorClipboardUnavailable);
      setButtonState("error");
      setTimeout(() => setButtonState("idle"), 2500);
      return;
    }

    setButtonState("loading");

    // Checked explicitly, upfront, separately from the try/catch below --
    // see loggedOutReason's comment for why. Confirmed live: WCL's token
    // endpoint doesn't count against the points/rate-limit budget (only
    // GraphQL queries do), so re-checking here on every single Import
    // click costs nothing.
    try {
      await validateCredentials(creds.clientId, creds.clientSecret);
    } catch {
      await clearCredentials();
      setCreds(null);
      setLoggedOutReason(t.apiKeyInvalid);
      setButtonState("idle");
      return;
    }
    try {
      const rawText = await navigator.clipboard.readText();
      // Stashed before parsing even attempts -- if parseClipboardText below
      // throws (wrong version, garbage clipboard, etc.), Source should still
      // be able to hand back exactly what was actually read.
      setLastSourceText(rawText);
      // The addon exports "...:Type:Difficulty:InstanceName:e<version>" now
      // -- Type/Difficulty distinguish a Mythic+ listing from a raid one
      // (and, for raid, which difficulty), InstanceName is the current
      // Keystone dungeon or raid zone name (empty if no active listing).
      // Rating/ItemLevel/Role/SpecID are Blizzard's own in-game values (see
      // Core.lua's GetApplicantNames/GetCurrentInstanceInfo), free with the
      // same call that gets the name.
      const { contentType, raidDifficultyCode, instanceName, entries } = parseClipboardText(rawText);
      if (entries.length === 0) {
        throw new Error(t.errorNoNames);
      }
      const names = entries.map((e) => e.key);
      const blizzardScoreByKey = new Map(entries.map((e) => [e.key, e.blizzardScore]));
      const blizzardItemLevelByKey = new Map(entries.map((e) => [e.key, e.blizzardItemLevel]));
      const roleByKey = new Map(entries.map((e) => [e.key, e.addonRole]));
      const specIdByKey = new Map(entries.map((e) => [e.key, e.addonSpecId]));

      // Always resolved regardless of dungeonMode -- both season and
      // dungeon values get fetched every time (one WCL query covers both,
      // see lib/wcl.ts), so switching the Season/Dungeon toggle afterwards
      // can update the table instantly instead of needing a re-import.
      let finalResults = await runLookup(
        names,
        creds.clientId,
        creds.clientSecret,
        contentType,
        instanceName,
        raidDifficultyCode,
        roleByKey,
        specIdByKey
      );
      finalResults = finalResults.map((r) => {
        const blizzardItemLevel = blizzardItemLevelByKey.get(r.key) ?? 0;
        return {
          ...r,
          blizzardScore: blizzardScoreByKey.get(r.key) ?? 0,
          blizzardItemLevel,
          // Default the visible iLvl slot to Blizzard's own value right
          // away -- fetchRioScores (below, only when raider.io is actually
          // used) overwrites it with raider.io's own itemLevel later.
          itemLevel: blizzardItemLevel,
        };
      });

      // The Score column is always shown now (not just while Filter is on),
      // so the IO slot always needs resolving here -- same as before, just
      // no longer gated on filterEnabled. Lazy-loading raider.io (see the
      // effect above) is now only for turning the RaiderIO toggle on/off
      // AFTER an already-finished lookup, not for Filter.
      if (raiderIoEnabled) {
        setRioLoading(true);
        finalResults = await fetchRioScores(finalResults, REGION);
        setRioLoading(false);
      } else {
        finalResults = applyBlizzardScoreAsIo(finalResults);
      }
      setRioLoaded(true);
      setResults(finalResults);

      // Always exported in the original applicant-list order, filter or
      // not: WoW's Group Finder applicant list has no API to reorder
      // (confirmed against Blizzard's own LFGList.lua -- displayOrderID is
      // read-only), so re-sorting the export string wouldn't let the addon
      // re-sort its native window either -- it'd just make the string
      // harder to match against what's on screen in-game. Rank always
      // blends both weights now, Filter on or not -- Filter's only job is
      // showing/hiding the weight sliders (see effectiveLogsWeight/
      // effectiveIoWeight below), not gating whether Score factors into the
      // rank at all; ignoring Score whenever Filter happened to be off was
      // confusing (the Score column is always visible now, so it looking
      // uninvolved in ranking read as broken). The Score slot is already
      // resolved above regardless of Filter, so there's no "IO not ready
      // yet" case to guard against here either.
      const rankedResults: RankedResult[] = withRanks(
        withEffectiveMode(finalResults, dungeonMode),
        logsWeight,
        ioWeight
      );
      await navigator.clipboard.writeText(toExportString(rankedResults));

      setButtonState("done");
      setTimeout(() => setButtonState("idle"), 1800);
    } catch (err) {
      const isWrongVersion = err instanceof LookupError && err.code === "WRONG_ADDON_VERSION";
      const message = isWrongVersion
        ? t.wrongAddonVersion
        : err instanceof LookupError
          ? err.code === "NO_VALID_ENTRIES"
            ? t.noValidEntries
            : t.configIncomplete
          : (err as Error).message;
      setErrorMessage(message);
      setVersionMismatch(isWrongVersion);
      setButtonState("error");
      setTimeout(() => setButtonState("idle"), 2500);
    }
  }

  if (credsLoading) {
    return null;
  }

  if (!creds) {
    return (
      <div className="qa-card" style={{ textAlign: "center" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 14px" }}>{t.onboardingHeading}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#aaa", margin: "0 0 10px" }}>
          {t.introInstruction}{" "}
          <a
            href="https://www.warcraftlogs.com/api/clients/"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#3fc7eb" }}
          >
            warcraftlogs.com/api/clients
          </a>
          .
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#aaa", margin: "0 0 10px" }}>
          Application Name: <b>analyzer</b>
          <br />
          Redirect URL: <b>http://analyzer.com</b>
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#aaa", margin: 0 }}>{t.introStore}</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
          <input
            type="text"
            placeholder={t.clientIdPlaceholder}
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            className="qa-input"
          />
          <input
            type="password"
            placeholder={t.clientSecretPlaceholder}
            value={clientSecretInput}
            onChange={(e) => setClientSecretInput(e.target.value)}
            className="qa-input"
          />
          <button
            type="button"
            onClick={handleSaveCredentials}
            disabled={validating}
            style={{
              padding: "10px 18px",
              background: validating ? "#2a2f36" : "#3fc7eb",
              color: validating ? "#888" : "#0a0a0a",
              border: "none",
              borderRadius: 8,
              fontWeight: 700,
              cursor: validating ? "default" : "pointer",
            }}
          >
            {validating ? t.savingButton : t.saveButton}
          </button>
          {validationError && <p style={{ color: "#ff6b6b", margin: 0, fontSize: 13 }}>{validationError}</p>}
          {loggedOutReason && <p style={{ color: "#ff6b6b", margin: 0, fontSize: 13 }}>{loggedOutReason}</p>}
        </div>
      </div>
    );
  }

  const colors = BUTTON_COLOR[buttonState];

  // Score column: shown and populated regardless of Filter now -- only
  // waits on rioLoaded (the actual data being ready), not on the Filter
  // toggle.
  const showIoColumn = rioLoaded;
  // Rank/weighting: always blends both, Filter on or not -- Filter's only
  // job is showing/hiding the weight sliders, not gating whether Score
  // factors into the rank (see the comment where this same pair is used in
  // handleReadFromClipboard for why). Still waits on rioLoaded specifically
  // -- using the real ioWeight before the Score slot is actually populated
  // would rank everyone as if their IO score were 0, a confusing order
  // that's about to jump around the moment the fetch finishes.
  const effectiveLogsWeight = rioLoaded ? logsWeight : 100;
  const effectiveIoWeight = rioLoaded ? ioWeight : 0;
  // Unranked (tanks/healers, rank 0) always sort to the end, after every
  // real rank -- "erscheinen am Ende der Tabelle ohne Rang".
  const displayRows = results
    ? withRanks(withEffectiveMode(results, dungeonMode), effectiveLogsWeight, effectiveIoWeight)
        .slice()
        .sort((a, b) => {
          if (a.rank === 0 && b.rank === 0) return 0;
          if (a.rank === 0) return 1;
          if (b.rank === 0) return -1;
          return a.rank - b.rank;
        })
    : [];

  return (
    <div className="qa-card" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <button
        type="button"
        onClick={handleReadFromClipboard}
        disabled={buttonState === "loading"}
        style={{
          display: "inline-grid",
          // +2px over the browser's UA-default button font size (13.3333px
          // in Chrome, confirmed via devtools) -- never explicitly set
          // before now, so it was riding on that quirky default.
          fontSize: "15.3333px",
          padding: "10px 18px",
          background: colors.bg,
          color: colors.fg,
          border: "none",
          borderRadius: 8,
          fontWeight: 700,
          cursor: buttonState === "loading" ? "default" : "pointer",
        }}
      >
        {/* All four labels are stacked in the same grid cell (only the
            active one visible) so the grid track sizes to the widest AND
            tallest of them (the spinner in "loading" is the tallest) --
            the button's box is then fixed across state changes instead of
            jumping around as the text (and its length, which varies per
            language) changes. Each span stretches to fill that cell
            (default grid align-items/justify-items: stretch), so each one
            also needs its own flex centering -- otherwise its text just
            sits at the top of that stretched box instead of centered in
            it, most visible whenever the cell is taller than a plain text
            line (i.e. whenever "loading" isn't the active state). */}
        <span style={buttonLabelStyle(buttonState === "idle")}>{t.buttonIdle}</span>
        <span style={buttonLabelStyle(buttonState === "loading")}>
          <span className="qa-spinner" />
          {t.buttonLoading}
        </span>
        <span style={buttonLabelStyle(buttonState === "done")}>{t.buttonDone}</span>
        <span style={buttonLabelStyle(buttonState === "error" && !versionMismatch)}>{t.buttonErrorRetry}</span>
        <span style={buttonLabelStyle(buttonState === "error" && versionMismatch)}>{t.buttonWrongVersion}</span>
      </button>

      {/* No inline error message shown here on purpose -- a <p> that only
          exists while buttonState === "error" pushed everything below it
          around each time an error appeared/cleared. The button's own
          "Error - try again" state (color + label) is the only error
          feedback for now; errorMessage is still tracked in state (see
          handleReadFromClipboard) in case a non-layout-shifting way to
          surface it (e.g. a tooltip) gets added later. */}

      {/* Preview and Filter are independent toggles, peers of each other:
          Preview alone just shows the table (Name + WCL Log%). Filter alone
          reveals the weight sliders and switches the table to Rank order,
          using Blizzard's own in-game rating (free, no request) as the
          Score source by default. */}
      <div style={{ display: "flex", gap: 20, marginTop: 22 }}>
        <label className="qa-toggle">
          <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
          <span className="qa-toggle-track" />
          <span className="qa-toggle-label">Preview</span>
        </label>

        <label className="qa-toggle">
          <input type="checkbox" checked={filterEnabled} onChange={(e) => setFilterEnabled(e.target.checked)} />
          <span className="qa-toggle-track" />
          <span className="qa-toggle-label">Filter</span>
        </label>
      </div>

      {/* The two two-way toggles below share one grid (label | switch |
          label columns) instead of each being its own centered flex row --
          that left their switches at different x-positions depending on
          each row's label text length. The grid keeps both switches
          lined up under each other. Each <label> is display:contents so its
          children become direct grid items (the still-adjacent, just
          invisible, checkbox stays out of grid flow entirely since it's
          absolutely positioned -- see .qa-toggle input in globals.css --
          so it doesn't consume a column). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          rowGap: 10,
          // .qa-toggle's own `gap` (flex) has no effect once display is
          // overridden to "contents" below, so the label<->switch spacing
          // has to come from the grid's own columnGap instead.
          columnGap: 10,
          marginTop: 14,
        }}
      >
        {/* Season vs Dungeon -- which WCL data the LOG value comes from.
            Unchecked (left/default) = the whole season's zoneRankings.
            Checked (right) = just the leader's current Keystone dungeon
            (encounterRankings), using the dungeon name the addon exports
            alongside the applicant list. Falls back to Season data by
            itself if there's no active Keystone listing or the name
            doesn't match a known dungeon -- see runLookup in lib/lookup.ts. */}
        <label className="qa-toggle qa-toggle-2way" style={{ display: "contents" }}>
          <span className="qa-toggle-label" style={{ justifySelf: "end" }} data-active={dungeonMode === "season"}>
            Season Log
          </span>
          <input
            type="checkbox"
            checked={dungeonMode === "dungeon"}
            onChange={(e) => setDungeonMode(e.target.checked ? "dungeon" : "season")}
          />
          <span className="qa-toggle-track" />
          <span className="qa-toggle-label" style={{ justifySelf: "start" }} data-active={dungeonMode === "dungeon"}>
            Dungeon Log
          </span>
        </label>

        {/* Blizzard vs RaiderIO -- which source feeds the Score slot once
            Filter is on. Unchecked (left/default) = Blizzard's own in-game
            rating, already in the export, no network request. Checked
            (right) = an actual raider.io lookup. */}
        <label className="qa-toggle qa-toggle-2way" style={{ display: "contents" }}>
          <span className="qa-toggle-label" style={{ justifySelf: "end" }} data-active={!raiderIoEnabled}>
            Blizzard Score
          </span>
          <input type="checkbox" checked={raiderIoEnabled} onChange={(e) => setRaiderIoEnabled(e.target.checked)} />
          <span className="qa-toggle-track" />
          <span className="qa-toggle-label" style={{ justifySelf: "start" }} data-active={raiderIoEnabled}>
            RaiderIO Score
          </span>
        </label>

      </div>

      {filterEnabled && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 28px", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#aaa", fontWeight: 700, letterSpacing: "0.03em" }}>LOG</span>
            <input
              className="qa-slider"
              type="range"
              min={0}
              max={100}
              step={5}
              value={logsWeight}
              onChange={(e) => setLogsWeight(Number(e.target.value))}
            />
            <span style={{ fontSize: 12, color: "#ddd", fontWeight: 700, textAlign: "right" }}>{logsWeight}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 28px", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#aaa", fontWeight: 700, letterSpacing: "0.03em" }}>SCORE</span>
            <input
              className="qa-slider"
              type="range"
              min={0}
              max={100}
              step={5}
              value={ioWeight}
              onChange={(e) => setIoWeight(Number(e.target.value))}
            />
            <span style={{ fontSize: 12, color: "#ddd", fontWeight: 700, textAlign: "right" }}>{ioWeight}</span>
          </div>
        </div>
      )}

      {previewEnabled && results && (
        <table className="qa-table" style={{ marginTop: 20 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "right", width: "1%", whiteSpace: "nowrap" }}>Rank</th>
              <th style={{ textAlign: "right", width: "1%", whiteSpace: "nowrap" }}>Tier</th>
              <th style={{ textAlign: "left" }}>Name</th>
              <th>iLvl</th>
              <th>LOG</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => (
              <tr key={r.key}>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontWeight: 700, color: rankColor(r.rank) }}>
                  {r.rank === 0 && (r.role === "tank" || r.role === "healer") ? (
                    <RoleIcon role={r.role} color="#FFFFFF" />
                  ) : (
                    formatRank(r.rank)
                  )}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontWeight: 700, color: r.tier ? TIER_COLOR[r.tier] : undefined }}>
                  {r.tier ?? "-"}
                </td>
                <td style={{ textAlign: "left", fontWeight: 600 }}>
                  <a
                    href={wclCharacterUrl(r.name, r.realm)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: r.classId ? CLASS_COLORS[r.classId] : "inherit", textDecoration: "none" }}
                  >
                    {r.name}
                  </a>
                </td>
                <td style={{ color: r.itemLevel > 0 ? "#ddd" : undefined, fontWeight: 700 }}>
                  {r.itemLevel > 0 ? Math.round(r.itemLevel) : "-"}
                </td>
                <td style={{ color: r.error ? undefined : percentileColor(r.best), fontWeight: 700 }}>
                  {r.error ? "-" : String(Math.round(r.best)).padStart(2, "0")}
                </td>
                <td style={{ color: showIoColumn && r.ioScore > 0 ? r.ioColor : undefined, fontWeight: 700 }}>
                  {showIoColumn ? (r.ioScore > 0 ? Math.round(r.ioScore) : "-") : <span className="qa-spinner" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Three-column grid (empty / Logout / Clear) instead of a plain row --
          the two 1fr side columns stay equal width no matter what's in
          them, so Logout in the middle column stays truly centered on the
          card even though Clear (right column, pushed to its far edge)
          only exists on one side. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", width: "100%", marginTop: 22 }}>
        <button
          type="button"
          onClick={handleCopySource}
          disabled={!lastSourceText}
          style={{
            background: "none",
            border: "none",
            color: lastSourceText ? "#888" : "#444",
            fontSize: 12,
            cursor: lastSourceText ? "pointer" : "default",
            padding: 0,
            justifySelf: "start",
            // Mirrors Clear's own marginRight/paddingRight (opposite side,
            // same 10%/10% amounts) so both sit the same distance from their
            // respective card edge.
            marginLeft: "10%",
            paddingLeft: "10%",
          }}
        >
          Source
        </button>
        <button
          type="button"
          onClick={handleResetCredentials}
          style={{
            background: "none",
            border: "none",
            color: "#888",
            fontSize: 12,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {t.logoutButton}
        </button>
        <button
          type="button"
          onClick={handleClearResults}
          style={{
            background: "none",
            border: "none",
            color: "#888",
            fontSize: 12,
            cursor: "pointer",
            padding: 0,
            justifySelf: "end",
            // Both relative to the column's own width, not the whole card.
            // marginRight keeps the button itself off the card's right
            // edge; paddingRight (added on top, per request) widens its own
            // clickable/visual box a further 10% so the text sits even
            // further from the edge.
            marginRight: "10%",
            paddingRight: "10%",
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
