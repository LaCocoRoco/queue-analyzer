/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export -- no Node server at runtime. Deployed to GitHub
  // Pages via .github/workflows/deploy-pages.yml. Safe now that the WCL
  // calls moved into the browser (see lib/wcl.ts) -- there's nothing left
  // that needs a server.
  output: "export",
  // GitHub Pages serves a project repo (not <user>.github.io itself) under
  // /<repo-name>/, so asset URLs need that prefix -- but only in that
  // deployment, not in local dev. Left empty unless the workflow sets it.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
};

export default nextConfig;
