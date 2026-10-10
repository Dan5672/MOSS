// Pi-hole and AdGuard Home: network-wide ad and tracker blocking. Health checks watch that blocking is on (it's
// easy to pause and forget) with the day's queries and block rate as readings; the inventory sync brings the
// device names they know into MOSS.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import type { FeatureOutput, IntegrationDef, InventoryItem } from "./types.js";

const HEALTH_EVERY = 5 * 60_000;
const INVENTORY_EVERY = 6 * 60 * 60_000;
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);
const defined = (o: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "number")) as Record<string, number>;

interface PiholeSummary {
  blocking?: string;
  queries?: number;
  blocked?: number;
  blockedPercent?: number;
  activeClients?: number;
}

export function piholeHealth(r: PiholeSummary): FeatureOutput {
  const values = defined({ queries: r.queries, blocked: r.blocked, blockedPercent: round(r.blockedPercent), activeClients: r.activeClients });
  const on = r.blocking === "enabled";
  const alerts: ParsedAlert[] = [
    { key: "reachable", name: "Pi-hole", status: "up", message: "Pi-hole is answering", values },
    {
      key: "blocking",
      name: "Pi-hole blocking",
      status: on ? "up" : r.blocking === "disabled" ? "degraded" : "down",
      message: on ? `Blocking ${values.blockedPercent ?? "?"}% of ${values.queries ?? "?"} queries today` : r.blocking === "disabled" ? "Blocking is paused" : `Blocking is ${r.blocking ?? "unknown"}`,
      ...(values.blockedPercent !== undefined ? { value: values.blockedPercent, unit: "%" } : {}),
      values,
    },
  ];
  return { alerts, summary: on ? `Blocking on, ${values.blockedPercent ?? "?"}% of ${values.queries ?? "?"} queries blocked` : `Blocking ${r.blocking ?? "unknown"}` };
}

interface PiholeClients {
  devices: { mac?: string; vendor?: string; name?: string; ips: string[] }[];
}

/** Pi-hole knows each device by MAC; names come from the addresses' reverse DNS. */
export function piholeInventory(r: PiholeClients): FeatureOutput {
  const inventory: InventoryItem[] = r.devices
    .filter((d) => d.mac || d.ips.length)
    .map((d) => ({
      externalId: d.mac ? `mac:${d.mac}` : `ip:${d.ips[0]}`,
      name: d.name?.replace(/\.(lan|local|home|internal|localdomain)$/i, ""),
      vendor: d.vendor,
      ips: d.ips,
      macs: d.mac ? [d.mac] : [],
    }));
  return { inventory };
}

interface AdguardStats {
  version?: string;
  protectionEnabled?: boolean;
  queries?: number;
  blocked?: number;
  blockedPercent?: number;
  avgProcessingMs?: number;
}

export function adguardHealth(r: AdguardStats): FeatureOutput {
  const values = defined({ queries: r.queries, blocked: r.blocked, blockedPercent: round(r.blockedPercent), avgProcessingMs: r.avgProcessingMs });
  const alerts: ParsedAlert[] = [
    { key: "reachable", name: "AdGuard Home", status: "up", message: `AdGuard Home ${r.version ?? ""} is answering`.replace("  ", " "), values },
    {
      key: "protection",
      name: "AdGuard Home protection",
      status: r.protectionEnabled ? "up" : "degraded",
      message: r.protectionEnabled ? `Blocking ${values.blockedPercent ?? "?"}% of ${values.queries ?? "?"} queries` : "Protection is off",
      ...(values.blockedPercent !== undefined ? { value: values.blockedPercent, unit: "%" } : {}),
      values,
    },
  ];
  return { alerts, summary: r.protectionEnabled ? `Protection on, ${values.blockedPercent ?? "?"}% blocked` : "Protection off" };
}

interface AdguardClients {
  clients: { name?: string; macs: string[]; ips: string[]; configured: boolean }[];
}

export function adguardInventory(r: AdguardClients): FeatureOutput {
  const inventory: InventoryItem[] = r.clients
    .filter((c) => c.macs.length || c.ips.length)
    .map((c) => ({
      externalId: c.macs[0] ? `mac:${c.macs[0]}` : `ip:${c.ips[0]}`,
      name: c.name?.replace(/\.(lan|local|home|internal|localdomain)$/i, ""),
      ips: c.ips,
      macs: c.macs,
    }));
  return { inventory };
}

const nameHint = "Each device keeps a name you gave it; only automatically named ones are renamed.";

export const PIHOLE: IntegrationDef = {
  key: "pihole",
  name: "Pi-hole",
  description: "Watch that blocking stays on, graph queries and the block rate, and bring the device names Pi-hole knows into the inventory.",
  plan: "free",
  connection: { defaultPort: 80, scheme: { default: "http" }, hint: "Pi-hole v6 or newer." },
  credential: {
    secretName: "pihole-password",
    type: "password",
    arg: "password",
    label: "App password",
    hint: "Pi-hole: Settings > Web interface / API > Configure app password (the web password works too).",
    tools: ["pihole_summary", "pihole_clients", "pihole_domain_rule", "pihole_local_dns"],
  },
  test: {
    op: "summary",
    describe: (r) => {
      const s = r as PiholeSummary;
      return `Connected to Pi-hole: ${s.queries ?? "?"} queries today, ${round(s.blockedPercent) ?? "?"}% blocked, blocking ${s.blocking ?? "unknown"}.`;
    },
  },
  ops: { summary: { tool: "pihole_summary" }, clients: { tool: "pihole_clients" } },
  features: [
    { key: "health", label: "Health checks", description: "Every 5 minutes: is Pi-hole answering, and is blocking on? With queries and the block rate as readings.", everyMs: HEALTH_EVERY, op: "summary", apply: (r) => piholeHealth(r as PiholeSummary) },
    { key: "inventory", label: "Device names", description: `Every 6 hours: the devices Pi-hole has seen, with their names. ${nameHint}`, everyMs: INVENTORY_EVERY, op: "clients", apply: (r) => piholeInventory(r as PiholeClients) },
  ],
  agentTools: ["pihole_summary", "pihole_clients", "pihole_domain_rule", "pihole_local_dns"],
};

export const ADGUARD: IntegrationDef = {
  key: "adguard",
  name: "AdGuard Home",
  description: "Watch that protection stays on, graph queries, the block rate and response time, and bring client names into the inventory.",
  plan: "free",
  connection: { defaultPort: 80, scheme: { default: "http" }, user: { label: "User name" }, hint: "The address and port of AdGuard Home's web interface." },
  credential: {
    secretName: "adguard-password",
    type: "password",
    arg: "password",
    label: "Password",
    hint: "The password of that AdGuard Home user.",
    tools: ["adguard_stats", "adguard_clients", "adguard_rule", "adguard_rewrite"],
  },
  test: {
    op: "stats",
    describe: (r) => {
      const s = r as AdguardStats;
      return `Connected to AdGuard Home ${s.version ?? ""}: ${s.queries ?? "?"} queries, ${round(s.blockedPercent) ?? "?"}% blocked, protection ${s.protectionEnabled ? "on" : "off"}.`.replace("  ", " ");
    },
  },
  ops: { stats: { tool: "adguard_stats" }, clients: { tool: "adguard_clients" } },
  features: [
    { key: "health", label: "Health checks", description: "Every 5 minutes: is AdGuard Home answering, and is protection on? With queries, the block rate and response time as readings.", everyMs: HEALTH_EVERY, op: "stats", apply: (r) => adguardHealth(r as AdguardStats) },
    { key: "inventory", label: "Device names", description: `Every 6 hours: AdGuard Home's clients, with their names. ${nameHint}`, everyMs: INVENTORY_EVERY, op: "clients", apply: (r) => adguardInventory(r as AdguardClients) },
  ],
  agentTools: ["adguard_stats", "adguard_clients", "adguard_rule", "adguard_rewrite"],
};
