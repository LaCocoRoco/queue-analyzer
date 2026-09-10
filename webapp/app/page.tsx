import LookupForm from "./LookupForm";

export default function Page() {
  return (
    <main
      style={{
        maxWidth: 400,
        margin: "40px auto",
        padding: "0 16px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Queue Analyzer</h1>

      <LookupForm />
    </main>
  );
}
