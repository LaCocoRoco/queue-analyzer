import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Queue Analyzer",
  description: "WarcraftLogs Mythic+ Season Lookup",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body style={{ margin: 0, background: "#111417", color: "#e8e8e8" }}>{children}</body>
    </html>
  );
}
