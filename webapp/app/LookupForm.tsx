"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { clearCredentials, loadCredentials, saveCredentials, type WclCredentials } from "@/lib/credentials";
import { detectLocale, DICTS, DEFAULT_LOCALE } from "@/lib/i18n";
import { LookupError, runLookup, type LookupResult } from "@/lib/lookup";
import { validateCredentials } from "@/lib/wcl";

// Flat ":"-delimited "Name-Realm:Best:Name-Realm:Best:..." -- the format
// the addon's import window parses (see Core.lua's ParseImportText). A
// single line pastes far more reliably into WoW's EditBox than a
// multi-line block. Safe because names/realms never contain ":".
function toExportString(results: LookupResult[]): string {
  return results
    .filter((r) => !r.error)
    .flatMap((r) => [r.key, r.best.toFixed(1)])
    .join(":");
}

type ButtonState = "idle" | "loading" | "done" | "error";

const BUTTON_COLOR: Record<ButtonState, { bg: string; fg: string }> = {
  idle: { bg: "#3fc7eb", fg: "#0a0a0a" },
  loading: { bg: "#ff8000", fg: "#0a0a0a" },
  done: { bg: "#1eff00", fg: "#0a0a0a" },
  error: { bg: "#ff4d4d", fg: "#fff" },
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  background: "#1a1d21",
  color: "#fff",
  border: "1px solid #333",
  borderRadius: 6,
  fontSize: 14,
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

  useEffect(() => {
    setLocale(detectLocale());
    loadCredentials()
      .then(setCreds)
      .catch(() => setCreds(null))
      .finally(() => setCredsLoading(false));
  }, []);

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
      const names = rawText
        .split(/[:\n]/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (names.length === 0) {
        throw new Error(t.errorNoNames);
      }

      const results = await runLookup(names, creds.clientId, creds.clientSecret);
      await navigator.clipboard.writeText(toExportString(results));

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
      <div style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>{t.onboardingHeading}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc" }}>
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
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc" }}>
          Application Name: <b>analyzer</b>
          <br />
          Redirect URL: <b>http://analyzer.com</b>
        </p>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc" }}>{t.introStore}</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          <input
            type="text"
            placeholder={t.clientIdPlaceholder}
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password"
            placeholder={t.clientSecretPlaceholder}
            value={clientSecretInput}
            onChange={(e) => setClientSecretInput(e.target.value)}
            style={inputStyle}
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
              borderRadius: 6,
              fontWeight: 600,
              cursor: validating ? "default" : "pointer",
            }}
          >
            {validating ? t.savingButton : t.saveButton}
          </button>
          {validationError && <p style={{ color: "#ff6b6b", margin: 0 }}>{validationError}</p>}
        </div>
      </div>
    );
  }

  const colors = BUTTON_COLOR[buttonState];

  return (
    <div>
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
          borderRadius: 6,
          fontWeight: 600,
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

      {errorMessage && buttonState === "error" && <p style={{ color: "#ff6b6b", marginTop: 12 }}>{errorMessage}</p>}

      <p style={{ marginTop: 20 }}>
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
      </p>
    </div>
  );
}
