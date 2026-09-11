"use client";

import { useState, type CSSProperties } from "react";

interface LookupResult {
  key: string;
  name: string;
  realm: string;
  classId: number | null;
  found: boolean;
  best: number;
  median: number;
  runs: number;
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

// WarcraftLogs' own parse-percentile color tiers -- confirmed via multiple
// independent sources (couldn't pull exact hex values directly off WCL's
// site, it blocks automated requests; these are the standard values also
// used for WoW's own item-quality colors, which WCL's grey/green/blue/
// purple/orange naming deliberately mirrors).
function percentileColor(pct: number): string {
  if (pct >= 95) return "#FF8000"; // orange
  if (pct >= 75) return "#A335EE"; // purple
  if (pct >= 50) return "#0070DD"; // blue
  if (pct >= 25) return "#1EFF00"; // green
  return "#9D9D9D"; // grey
}

// As tight as possible: no vertical padding, just enough horizontal gap to
// keep adjacent columns from visually merging.
const cellStyle: CSSProperties = {
  border: "1px solid #333",
  padding: "0 4px",
  textAlign: "left",
  lineHeight: 1.6,
};

// Best/Median/Runs share one fixed width, sized to comfortably fit the
// widest of the three ("Median") plus typical values -- no wider than
// that, and all three equal instead of each auto-sizing independently.
const numericCellStyle: CSSProperties = {
  ...cellStyle,
  width: 56,
  whiteSpace: "nowrap",
};

export default function LookupForm() {
  const [results, setResults] = useState<LookupResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      {error && <p style={{ color: "#ff6b6b", marginTop: 12 }}>{error}</p>}

      {results && (
        <table
          style={{
            marginTop: 10,
            borderCollapse: "collapse",
            fontSize: 16,
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
                    color: r.error ? undefined : percentileColor(r.best),
                    fontWeight: 700,
                  }}
                >
                  {r.error ? "Fehler" : r.best.toFixed(1)}
                </td>
                <td
                  style={{
                    ...numericCellStyle,
                    color: r.error ? undefined : percentileColor(r.median),
                    fontWeight: 700,
                  }}
                >
                  {r.error ? "" : r.median.toFixed(1)}
                </td>
                <td style={numericCellStyle}>{r.error ? "" : r.runs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
