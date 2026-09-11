import LookupForm from "./LookupForm";

export default function Page() {
  return (
    <main
      style={{
        width: "fit-content",
        margin: "40px auto",
        padding: "0 10px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Queue Analyzer</h1>

      <LookupForm />
    </main>
  );
}
