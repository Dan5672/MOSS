// Cloudflare: tunnels as monitors, and an exposure report of every hostname the internet can reach through
// Cloudflare (proxied records, records pointing at public addresses, and tunnel routes). A new one makes the
// "public hostnames" monitor degraded until someone marks them as expected, so nothing gets exposed unnoticed.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import type { FeatureOutput, IntegrationConfig, IntegrationDef } from "./types.js";

interface DnsResult {
  zones: { name?: string; records: { type?: string; name?: string; content?: string; proxied: boolean }[] }[];
}
interface TunnelResult {
  tunnels: { id?: string; name?: string; status: string; connections: number; hostnames: string[] }[];
}

export interface PublicHostname {
  name: string;
  type: string;
  content: string;
  via: "proxied" | "tunnel" | "public address";
}

/** What the exposure report last found, for the integration's page. */
export interface CloudflareState {
  exposure?: { at: string; hostnames: PublicHostname[] };
}

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:|::1$)/i;

/** Hostnames the internet can reach through Cloudflare. */
export function publicHostnames(r: DnsResult): PublicHostname[] {
  const out = new Map<string, PublicHostname>();
  for (const z of r.zones) {
    for (const rec of z.records) {
      if (!rec.name || !rec.content || !rec.type || !["A", "AAAA", "CNAME"].includes(rec.type)) continue;
      const via = rec.type === "CNAME" && rec.content.endsWith(".cfargotunnel.com") ? "tunnel" : rec.proxied ? "proxied" : rec.type !== "CNAME" && !PRIVATE.test(rec.content) ? "public address" : null;
      if (via) out.set(rec.name, { name: rec.name, type: rec.type, content: rec.content, via });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function acknowledgedHostnames(c: IntegrationConfig): string[] {
  const v = c.options.acknowledged;
  return Array.isArray(v) ? v.map(String) : [];
}

export function exposureHealth(r: DnsResult, c: IntegrationConfig, now: Date): FeatureOutput {
  const hostnames = publicHostnames(r);
  const known = new Set(acknowledgedHostnames(c));
  const fresh = hostnames.filter((h) => !known.has(h.name));
  const alerts: ParsedAlert[] = [
    {
      key: "exposure",
      name: "Cloudflare public hostnames",
      status: fresh.length ? "degraded" : "up",
      message: fresh.length
        ? `New public hostname${fresh.length === 1 ? "" : "s"}: ${fresh.map((h) => `${h.name} (${h.via})`).join(", ")}. Check, then mark them as expected in Settings → Integrations → Cloudflare.`
        : `${hostnames.length} public hostname(s), all expected`,
      value: hostnames.length,
    },
  ];
  return { alerts, summary: `${hostnames.length} public hostname(s)${fresh.length ? `, ${fresh.length} new` : ""}`, state: { exposure: { at: now.toISOString(), hostnames } } satisfies CloudflareState };
}

export function tunnelHealth(r: TunnelResult): FeatureOutput {
  const alerts: ParsedAlert[] = r.tunnels.map((t) => ({
    key: `tunnel:${t.id}`,
    name: `Cloudflare tunnel ${t.name ?? t.id}`,
    status: t.status === "healthy" ? "up" : t.status === "degraded" ? "degraded" : "down",
    message: `${t.status}, ${t.connections} connection(s)${t.hostnames.length ? `, serving ${t.hostnames.join(", ")}` : ""}`,
    values: { connections: t.connections },
  }));
  return { alerts, summary: `${r.tunnels.filter((t) => t.status === "healthy").length} of ${r.tunnels.length} tunnel(s) healthy` };
}

export const CLOUDFLARE: IntegrationDef = {
  key: "cloudflare",
  name: "Cloudflare",
  description: "Watch your tunnels, and know the moment anything new is exposed to the internet through Cloudflare. Agents can change DNS records through a change.",
  plan: "free",
  connection: {
    defaultPort: 443,
    cloud: true,
    hint: "MOSS reads api.cloudflare.com. For a trusted certificate for MOSS itself from Let's Encrypt, see Settings → HTTPS.",
  },
  credential: {
    secretName: "cloudflare-token",
    type: "api_token",
    arg: "apiToken",
    label: "API token",
    hint: "Cloudflare: My Profile > API Tokens > Create Token, with Zone: Read, DNS: Read and Account: Cloudflare Tunnel: Read (add DNS: Edit only if agents should change records).",
    tools: ["cloudflare_dns", "cloudflare_tunnels", "cloudflare_dns_record"],
  },
  test: {
    op: "dns",
    describe: (r) => {
      const d = r as DnsResult;
      return `Connected to Cloudflare: ${d.zones.length} zone(s), ${d.zones.reduce((n, z) => n + z.records.length, 0)} DNS record(s), ${publicHostnames(d).length} public hostname(s).`;
    },
  },
  ops: { dns: { tool: "cloudflare_dns" }, tunnels: { tool: "cloudflare_tunnels" } },
  features: [
    {
      key: "exposure",
      label: "Exposure report",
      description: "Every hour: every hostname reachable from the internet through Cloudflare (proxied records, records to public addresses, tunnel routes). A new one makes the monitor degraded until you mark them as expected.",
      everyMs: 60 * 60_000,
      op: "dns",
      apply: (r, { config, now }) => exposureHealth(r as DnsResult, config, now),
    },
    {
      key: "tunnels",
      label: "Tunnel checks",
      description: "Every 5 minutes: each Cloudflare Tunnel healthy, with its connections.",
      everyMs: 5 * 60_000,
      op: "tunnels",
      apply: (r) => tunnelHealth(r as TunnelResult),
    },
  ],
  agentTools: ["cloudflare_dns", "cloudflare_tunnels", "cloudflare_dns_record"],
};
