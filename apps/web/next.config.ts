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
  // MOSS reached through Tailscale (https://moss.<tailnet>.ts.net) keeps working if the proxy changes the Host header.
  // Another tailnet's site can't use this: ts.net is a public suffix, so the session cookie (SameSite=Lax) isn't sent.
  experimental: { serverActions: { allowedOrigins: ["*.ts.net"] } },
  // No other site may frame MOSS (clickjacking an Approve button). TV dashboards stay frameable, e.g. in Home Assistant.
  async headers() {
    return [
      {
        source: "/:path((?!tv/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  // Settings → Modules was renamed Integrations.
  async redirects() {
    return [
      { source: "/settings/modules", destination: "/settings/integrations", permanent: true },
      { source: "/settings/modules/:path*", destination: "/settings/integrations/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
