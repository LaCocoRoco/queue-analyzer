import LookupForm from "./LookupForm";

export default function Page() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 20,
        padding: "48px 16px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.01em", margin: 0 }}>Queue Analyzer</h1>

      <LookupForm />
    </main>
  );
}
