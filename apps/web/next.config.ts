import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // Self-hosted in Docker: a minimal server bundle with only the files it needs.
  output: "standalone",
  // Trace from the monorepo root so workspace packages (@moss/*) are included.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // Database and queue drivers stay as plain Node modules rather than being bundled.
  serverExternalPackages: ["postgres", "pg-boss"],
  poweredByHeader: false,
  // Settings → Modules was renamed Integrations.
  async redirects() {
    return [
      { source: "/settings/modules", destination: "/settings/integrations", permanent: true },
      { source: "/settings/modules/:path*", destination: "/settings/integrations/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
