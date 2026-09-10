import { getSession } from "@/lib/session";
import LookupForm from "./LookupForm";

export default function Page({ searchParams }: { searchParams: { error?: string } }) {
  const loggedIn = !!getSession();

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Queue Analyzer</h1>
      <p style={{ color: "#aaa" }}>
        Mythic+ Season Best/Median DPS % Avg und Runs (WarcraftLogs) für eine Liste von Namen -- aus dem{" "}
        <code>Queue Analyzer</code> WoW-Addon einfügen.
      </p>

      {searchParams.error && (
        <p style={{ color: "#ff6b6b" }}>
          Login fehlgeschlagen ({searchParams.error}). Bitte erneut versuchen.
        </p>
      )}

      {!loggedIn ? (
        <a
          href="/api/auth/login"
          style={{
            display: "inline-block",
            padding: "10px 16px",
            background: "#3fc7eb",
            color: "#0a0a0a",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Mit WarcraftLogs einloggen
        </a>
      ) : (
        <LookupForm />
      )}
    </main>
  );
}
