import LookupForm from "./LookupForm";

export default function Page() {
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>Queue Analyzer</h1>
      <p style={{ color: "#aaa" }}>
        Mythic+ Season Best/Median DPS % Avg und Runs (WarcraftLogs) für eine Liste von Namen -- aus dem{" "}
        <code>Queue Analyzer</code> WoW-Addon einfügen.
      </p>

      <LookupForm />
    </main>
  );
}
