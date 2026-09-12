"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { clearCredentials, loadCredentials, saveCredentials, type WclCredentials } from "@/lib/credentials";
import { detectLocale, DICTS, DEFAULT_LOCALE } from "@/lib/i18n";
import {
  fetchRioScores,
  LookupError,
  parseClipboardEntries,
  REGION,
  runLookup,
  withRanks,
  type LookupResult,
  type RankedResult,
} from "@/lib/lookup";
import { toServerSlug, validateCredentials } from "@/lib/wcl";

// Flat ":"-delimited "Name-Realm:Best:Rank:Name-Realm:Best:Rank:..." -- the
// format the addon's import window parses (see Core.lua's ParseImportText).
// A single line pastes far more reliably into WoW's EditBox than a
// multi-line block. Safe because names/realms never contain ":". Best is
// rounded to a whole number -- no decimals in anything that ends up visible
// in-game. Rank is always present (fixed triplets, never pairs) so the
// addon-side parser never has to guess the stride -- it's just 0 when
// Filter wasn't used for this export, which the addon reads as "no rank to
// show".
function toExportString(results: RankedResult[]): string {
  return results
    .filter((r) => !r.error)
    .flatMap((r) => [r.key, Math.round(r.best).toString(), r.rank.toString()])
    .join(":");
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
// matching the standard WoW item-quality colors those names mirror.
function percentileColor(pct: number): string {
  if (pct >= 95) return "#FF8000";
  if (pct >= 75) return "#A335EE";
  if (pct >= 50) return "#0070DD";
  if (pct >= 25) return "#1EFF00";
  return "#9D9D9D";
}

// Same character-profile URL WCL's own site uses.
function wclCharacterUrl(name: string, realm: string): string {
  return `https://www.warcraftlogs.com/character/${REGION.toLowerCase()}/${toServerSlug(realm)}/${encodeURIComponent(name)}`;
}

// Zero-padded to 2 digits (#1 -> #01) -- purely cosmetic, requested as a
// quick visual test; ranks past 99 just keep their natural width.
function formatRank(rank: number): string {
  return `#${String(rank).padStart(2, "0")}`;
}

// Copies Blizzard's own in-game Mythic+ rating (blizzardScore, sent by the
// addon alongside each name -- see lib/lookup.ts's parseClipboardEntries)
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

  const [buttonState, setButtonState] = useState<ButtonState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  useEffect(() => {
    if (!filterEnabled || !results || rioLoaded || rioLoading) {
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
  }, [filterEnabled, raiderIoEnabled, results, rioLoaded, rioLoading]);

  async function handleSaveCredentials() {
    setValidationError(null);
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

  async function handleResetCredentials() {
    await clearCredentials();
    setCreds(null);
    setClientIdInput("");
    setClientSecretInput("");
  }

  async function handleReadFromClipboard() {
    if (!creds || buttonState === "loading") return;
    setErrorMessage(null);

    if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
      setErrorMessage(t.errorClipboardUnavailable);
      setButtonState("error");
      setTimeout(() => setButtonState("idle"), 2500);
      return;
    }

    setButtonState("loading");
    try {
      const rawText = await navigator.clipboard.readText();
      // The addon exports "Name-Realm:Rating:Name-Realm:Rating:..." now --
      // Rating is Blizzard's own in-game Mythic+ rating (see Core.lua's
      // GetApplicantNames), free with the same call that gets the name.
      const entries = parseClipboardEntries(rawText);
      if (entries.length === 0) {
        throw new Error(t.errorNoNames);
      }
      const names = entries.map((e) => e.key);
      const blizzardScoreByKey = new Map(entries.map((e) => [e.key, e.blizzardScore]));

      let finalResults = await runLookup(names, creds.clientId, creds.clientSecret);
      finalResults = finalResults.map((r) => ({ ...r, blizzardScore: blizzardScoreByKey.get(r.key) ?? 0 }));

      // Lazy-loading raider.io (see the effect above) is only for turning
      // Filter on AFTER an already-finished lookup. If Filter is already on
      // right now, there's no "later" to defer to -- resolve the IO slot
      // before this handler is done, same as the pre-lazy-load design, so
      // the button doesn't claim "done" (and the table doesn't stop
      // spinning) while it's still missing. Only an actual network wait
      // (raider.io) needs that upfront resolve -- Blizzard's rating is
      // already in finalResults from the export, applying it is instant.
      if (filterEnabled) {
        if (raiderIoEnabled) {
          setRioLoading(true);
          finalResults = await fetchRioScores(finalResults, REGION);
          setRioLoading(false);
        } else {
          finalResults = applyBlizzardScoreAsIo(finalResults);
        }
        setRioLoaded(true);
      } else {
        setRioLoaded(false);
      }
      setResults(finalResults);

      // Always exported in the original applicant-list order, filter or
      // not: WoW's Group Finder applicant list has no API to reorder
      // (confirmed against Blizzard's own LFGList.lua -- displayOrderID is
      // read-only), so re-sorting the export string wouldn't let the addon
      // re-sort its native window either -- it'd just make the string
      // harder to match against what's on screen in-game. Rank is always
      // computed now (still in original order, see withRanks), not just
      // when Filter is on -- pure Logs ranking (ioWeight 0) when Filter is
      // off, so applicants still get a rank in-game even without ever
      // touching Filter.
      const rankedResults: RankedResult[] = withRanks(
        finalResults,
        filterEnabled ? logsWeight : 100,
        filterEnabled ? ioWeight : 0
      );
      await navigator.clipboard.writeText(toExportString(rankedResults));

      setButtonState("done");
      setTimeout(() => setButtonState("idle"), 1800);
    } catch (err) {
      const message =
        err instanceof LookupError
          ? err.code === "NO_VALID_ENTRIES"
            ? t.noValidEntries
            : t.configIncomplete
          : (err as Error).message;
      setErrorMessage(message);
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
        </div>
      </div>
    );
  }

  const colors = BUTTON_COLOR[buttonState];

  // A rank is always shown now, filter or not -- pure Logs ranking
  // (ioWeight 0) until Filter is actually on AND raider.io data has
  // arrived; using the real ioWeight before rioLoaded would rank everyone
  // as if their IO score were 0, a confusing order that's about to jump
  // around the moment the fetch finishes.
  const showIoColumn = filterEnabled && rioLoaded;
  const effectiveLogsWeight = showIoColumn ? logsWeight : 100;
  const effectiveIoWeight = showIoColumn ? ioWeight : 0;
  const displayRows = results
    ? withRanks(results, effectiveLogsWeight, effectiveIoWeight)
        .slice()
        .sort((a, b) => a.rank - b.rank)
    : [];

  return (
    <div className="qa-card" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <button
        type="button"
        onClick={handleReadFromClipboard}
        disabled={buttonState === "loading"}
        style={{
          display: "inline-grid",
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
            active one visible) so the grid track sizes to the widest of
            them -- the button's width is then fixed across state changes
            instead of jumping around as the text (and its length, which
            varies per language) changes. */}
        <span style={{ gridArea: "1 / 1", visibility: buttonState === "idle" ? "visible" : "hidden" }}>
          {t.buttonIdle}
        </span>
        <span style={{ gridArea: "1 / 1", visibility: buttonState === "loading" ? "visible" : "hidden" }}>
          <span className="qa-spinner" />
          {t.buttonLoading}
        </span>
        <span style={{ gridArea: "1 / 1", visibility: buttonState === "done" ? "visible" : "hidden" }}>
          {t.buttonDone}
        </span>
        <span style={{ gridArea: "1 / 1", visibility: buttonState === "error" ? "visible" : "hidden" }}>
          {t.buttonErrorRetry}
        </span>
      </button>

      {errorMessage && buttonState === "error" && (
        <p style={{ color: "#ff6b6b", marginTop: 12, fontSize: 13 }}>{errorMessage}</p>
      )}

      {/* Preview, Filter and RaiderIO are independent toggles, all peers of
          each other: Preview alone just shows the table (Name + WCL Log%).
          Filter alone reveals the weight sliders and switches the table to
          Rank order, using Blizzard's own in-game rating (free, no
          request) as the Score source by default. RaiderIO only matters
          once Filter is also on -- it swaps that default for an actual
          raider.io lookup instead. */}
      <div style={{ display: "flex", gap: 20, marginTop: 22, alignSelf: "flex-start" }}>
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

        <label className="qa-toggle">
          <input type="checkbox" checked={raiderIoEnabled} onChange={(e) => setRaiderIoEnabled(e.target.checked)} />
          <span className="qa-toggle-track" />
          <span className="qa-toggle-label">RaiderIO</span>
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
              <th style={{ textAlign: "left" }}>Name</th>
              <th>LOG</th>
              {filterEnabled && <th>Score</th>}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r) => (
              <tr key={r.key}>
                <td style={{ textAlign: "right", whiteSpace: "nowrap", fontWeight: r.rank === 1 ? 700 : 400 }}>
                  {formatRank(r.rank)}
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
                <td style={{ color: r.error ? undefined : percentileColor(r.best), fontWeight: 700 }}>
                  {r.error ? "-" : Math.round(r.best)}
                </td>
                {filterEnabled && (
                  <td style={{ color: showIoColumn && r.ioScore > 0 ? r.ioColor : undefined, fontWeight: 700 }}>
                    {showIoColumn ? (r.ioScore > 0 ? Math.round(r.ioScore) : "-") : <span className="qa-spinner" />}
                  </td>
                )}
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
        <span />
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
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
