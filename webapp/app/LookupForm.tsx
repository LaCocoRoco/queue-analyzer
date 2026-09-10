"use client";

import { useState, type CSSProperties, type FormEvent } from "react";

interface LookupResult {
  key: string;
  name: string;
  realm: string;
  found: boolean;
  best?: number;
  median?: number;
  runs?: number;
  error?: string;
}

const cellStyle: CSSProperties = { border: "1px solid #333", padding: "6px 10px", textAlign: "left" };

export default function LookupForm() {
  const [input, setInput] = useState("");
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
        "Zwischenablage-Zugriff nicht verfuegbar (braucht HTTPS oder localhost). Bitte unten manuell einfuegen."
      );
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      setInput(text);
      await runLookup(text);
    } catch {
      setError("Zugriff auf die Zwischenablage wurde verweigert. Bitte unten manuell einfuegen.");
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void runLookup(input);
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
          marginBottom: 16,
        }}
      >
        {loading ? "Frage ab..." : "Aus Zwischenablage abfragen"}
      </button>

      <details>
        <summary style={{ color: "#888", cursor: "pointer", fontSize: 13 }}>
          Manuell einfügen (falls Zwischenablage-Zugriff nicht klappt)
        </summary>
        <form onSubmit={handleSubmit} style={{ marginTop: 10 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"Name-Realm, eine Zeile pro Person\n(im Spiel: Queue Analyzer oeffnen, Strg+A, Strg+C, hier einfuegen)"}
            rows={8}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "monospace",
              fontSize: 14,
              padding: 10,
              background: "#1b1f24",
              color: "#e8e8e8",
              border: "1px solid #333",
              borderRadius: 6,
            }}
          />
          <button
            type="submit"
            disabled={loading || input.trim() === ""}
            style={{
              marginTop: 10,
              padding: "8px 16px",
              background: loading ? "#2a2f36" : "#3fc7eb",
              color: loading ? "#888" : "#0a0a0a",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Frage ab..." : "Abfragen"}
          </button>
        </form>
      </details>

      {error && <p style={{ color: "#ff6b6b", marginTop: 12 }}>{error}</p>}

      {results && (
        <table style={{ marginTop: 20, borderCollapse: "collapse", width: "100%" }}>
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
                <td style={cellStyle}>{r.key}</td>
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
