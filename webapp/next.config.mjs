/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces a minimal self-contained server bundle (.next/standalone),
  // which the Dockerfile copies -- keeps the container image small.
  output: "standalone",
};

export default nextConfig;
