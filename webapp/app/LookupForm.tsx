"use client";

import { useState, type CSSProperties } from "react";

interface LookupResult {
  key: string;
  name: string;
  realm: string;
  classId: number | null;
  found: boolean;
  best?: number;
  median?: number;
  runs?: number;
  error?: string;
}

// Standard WoW class colors (RAID_CLASS_COLORS), keyed by Blizzard's
// official numeric class ID. Duplicated from lib/wcl.ts's CLASS_BY_ID on
// purpose -- this is a client component, keep it free of the server-only
// WCL client code. Keyed by ID, not name: gameData's class name is
// localized (a German character came back as "Druide", not "Druid"),
// while the numeric ID is stable regardless of locale.
const CLASS_COLORS: Record<number, string> = {
  1: "#C69B6D", // Warrior
  2: "#F58CBA", // Paladin
  3: "#AAD372", // Hunter
  4: "#FFF468", // Rogue
  5: "#FFFFFF", // Priest
  6: "#C41F3B", // Death Knight
  7: "#0070DD", // Shaman
  8: "#3FC7EB", // Mage
  9: "#8788EE", // Warlock
  10: "#00FF98", // Monk
  11: "#FF7C0A", // Druid
  12: "#A330C9", // Demon Hunter
  13: "#33937F", // Evoker
};

const THRESHOLD_COLOR = "#3fe13f";

// As tight as possible: no vertical padding, just enough horizontal gap to
// keep adjacent columns from visually merging.
const cellStyle: CSSProperties = {
  border: "1px solid #333",
  padding: "0 4px",
  textAlign: "left",
  lineHeight: 1.3,
};

// Best/Median/Runs share one fixed width, sized to comfortably fit the
// widest of the three ("Median") plus typical values -- no wider than
// that, and all three equal instead of each auto-sizing independently.
const numericCellStyle: CSSProperties = {
  ...cellStyle,
  width: 56,
  whiteSpace: "nowrap",
  textAlign: "right",
};

export default function LookupForm() {
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0);

  async function runLookup(rawText: string) {
    const names = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (names.length === 0) return;

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `Fehler (${res.status})`);
      } else {
        setResults(body.results as LookupResult[]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleClipboardLookup() {
    setError(null);
    if (!navigator.clipboard?.readText) {
      setError(
        "Zwischenablage-Zugriff nicht verfuegbar (braucht HTTPS oder localhost).",
      );
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      await runLookup(text);
    } catch {
      setError("Zugriff auf die Zwischenablage wurde verweigert.");
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClipboardLookup}
        disabled={loading}
        style={{
          padding: "10px 18px",
          background: loading ? "#2a2f36" : "#3fc7eb",
          color: loading ? "#888" : "#0a0a0a",
          border: "none",
          borderRadius: 6,
          fontWeight: 600,
          cursor: loading ? "default" : "pointer",
        }}
      >
        {loading ? "Frage ab..." : "Aus Zwischenablage abfragen"}
      </button>

      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
        <label htmlFor="threshold" style={{ fontSize: 13, color: "#aaa", whiteSpace: "nowrap" }}>
          Gruen ab
        </label>
        <input
          id="threshold"
          type="range"
          min={0}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 13, color: THRESHOLD_COLOR, width: 32, textAlign: "right" }}>{threshold}%</span>
      </div>

      {error && <p style={{ color: "#ff6b6b", marginTop: 12 }}>{error}</p>}

      {results && (
        <table
          style={{
            marginTop: 10,
            borderCollapse: "collapse",
            width: "100%",
            fontSize: 12,
          }}
        >
          <thead>
            <tr>
              <th style={cellStyle}>Charakter</th>
              <th style={numericCellStyle}>Best</th>
              <th style={numericCellStyle}>Median</th>
              <th style={numericCellStyle}>Runs</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.key}>
                <td
                  style={{
                    ...cellStyle,
                    color: r.classId ? CLASS_COLORS[r.classId] : undefined,
                    fontWeight: 600,
                  }}
                >
                  {r.name}
                </td>
                <td
                  style={{
                    ...numericCellStyle,
                    color: r.found && r.best! >= threshold ? THRESHOLD_COLOR : undefined,
                    fontWeight: r.found && r.best! >= threshold ? 700 : undefined,
                  }}
                >
                  {r.found
                    ? r.best!.toFixed(1)
                    : r.error
                      ? "Fehler"
                      : "keine Logs"}
                </td>
                <td style={numericCellStyle}>{r.found ? r.median!.toFixed(1) : ""}</td>
                <td style={numericCellStyle}>{r.found ? r.runs : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
