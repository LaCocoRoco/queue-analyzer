"use client";

import { useState, type CSSProperties } from "react";

interface LookupResult {
  key: string;
  name: string;
  realm: string;
  className: string | null;
  found: boolean;
  best?: number;
  median?: number;
  runs?: number;
  error?: string;
}

// Standard WoW class colors (RAID_CLASS_COLORS). Duplicated from lib/wcl.ts
// on purpose -- this is a client component, keep it free of the
// server-only WCL client code.
const CLASS_COLORS: Record<string, string> = {
  "Death Knight": "#C41F3B",
  "Demon Hunter": "#A330C9",
  Druid: "#FF7C0A",
  Evoker: "#33937F",
  Hunter: "#AAD372",
  Mage: "#3FC7EB",
  Monk: "#00FF98",
  Paladin: "#F58CBA",
  Priest: "#FFFFFF",
  Rogue: "#FFF468",
  Shaman: "#0070DD",
  Warlock: "#8788EE",
  Warrior: "#C69B6D",
};

const cellStyle: CSSProperties = { border: "1px solid #333", padding: "3px 8px", textAlign: "left" };

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
      setError("Zwischenablage-Zugriff nicht verfuegbar (braucht HTTPS oder localhost).");
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
        <table style={{ marginTop: 20, borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={cellStyle}>Charakter</th>
              <th style={cellStyle}>Best %</th>
              <th style={cellStyle}>Median %</th>
              <th style={cellStyle}>Runs</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.key}>
                <td style={{ ...cellStyle, color: r.className ? CLASS_COLORS[r.className] : undefined, fontWeight: 600 }}>
                  {r.name}
                </td>
                <td style={cellStyle}>{r.found ? r.best!.toFixed(1) : r.error ? "Fehler" : "keine Logs"}</td>
                <td style={cellStyle}>{r.found ? r.median!.toFixed(1) : ""}</td>
                <td style={cellStyle}>{r.found ? r.runs : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
