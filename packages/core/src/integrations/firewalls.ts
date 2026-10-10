// OPNsense and pfSense, read the same way: gateways as monitors (online, packet loss, latency), DHCP leases for
// device names, and whether an update is waiting. Blocking a device is a change-gated write tool that only ever
// adds or removes an address in the "moss_blocked" alias the owner's own block rule uses.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef } from "./types.js";

interface FirewallStatus {
  product: "opnsense" | "pfsense";
  version?: string;
  leases: { ip: string; mac?: string; hostname?: string }[];
  gateways: { name: string; address?: string; online: boolean; status: string; lossPercent?: number; delayMs?: number }[];
  update?: { available: boolean; message?: string };
}

export function firewallHealth(def: IntegrationDef, r: FirewallStatus, c: IntegrationConfig): FeatureOutput {
  const lossWarn = integrationOption(def, c, "lossWarn");
  const alerts: ParsedAlert[] = r.gateways.map((g) => {
    const loss = g.lossPercent;
    const status = !g.online ? "down" : loss !== undefined && loss >= lossWarn ? "degraded" : "up";
    const values = Object.fromEntries(Object.entries({ lossPercent: loss, delayMs: g.delayMs }).filter(([, v]) => typeof v === "number")) as Record<string, number>;
    return {
      key: `gateway:${g.name}`,
      name: `${def.name} gateway ${g.name}`,
      status,
      message: g.online ? `${g.status}${g.delayMs !== undefined ? `, ${g.delayMs} ms` : ""}${loss !== undefined ? `, ${loss}% loss` : ""}` : `${g.status}`,
      ...(g.delayMs !== undefined ? { value: g.delayMs, unit: "ms" } : {}),
      values,
    };
  });
  const down = r.gateways.filter((g) => !g.online).length;
  const update = r.update?.available ? ` ${r.update.message ?? "An update is available"}.` : "";
  return { alerts, summary: `${def.name} ${r.version ?? ""}: ${r.gateways.length - down} of ${r.gateways.length} gateway(s) up, ${r.leases.length} DHCP lease(s).${update}`.replace("  ", " ") };
}

export function firewallInventory(r: FirewallStatus): FeatureOutput {
  return {
    inventory: r.leases.map((l) => ({
      externalId: l.mac ? `mac:${l.mac}` : `ip:${l.ip}`,
      name: l.hostname?.replace(/\.(lan|local|home|internal|localdomain)$/i, ""),
      ips: [l.ip],
      macs: l.mac ? [l.mac] : [],
    })),
  };
}

const describeStatus = (name: string) => (r: unknown) => {
  const s = r as FirewallStatus;
  return `Connected to ${name} ${s.version ?? ""}: ${s.gateways.length} gateway(s), ${s.leases.length} DHCP lease(s).${s.update?.available ? ` ${s.update.message ?? "An update is available"}.` : ""}`.replace("  ", " ");
};
const lossOption = [{ key: "lossWarn", label: "Gateway degraded at (% packet loss)", default: 5, min: 1, max: 100 }];

function features(def: () => IntegrationDef) {
  return [
    {
      key: "health",
      label: "Gateway checks",
      description: "Every 5 minutes: each gateway online, with packet loss and latency as readings. Degraded on packet loss, down when offline.",
      everyMs: 5 * 60_000,
      op: "status",
      apply: (r: unknown, ctx: { config: IntegrationConfig }) => firewallHealth(def(), r as FirewallStatus, ctx.config),
    },
    {
      key: "inventory",
      label: "Device names from DHCP",
      description: "Every 6 hours: the DHCP leases' host names name devices in the inventory (only automatically named ones are renamed).",
      everyMs: 6 * 60 * 60_000,
      op: "status",
      apply: (r: unknown) => firewallInventory(r as FirewallStatus),
    },
  ];
}

export const OPNSENSE: IntegrationDef = {
  key: "opnsense",
  name: "OPNsense",
  description: "Watch your gateways, name devices from DHCP, see when an update is waiting, and let agents block a device through a change.",
  plan: "free",
  connection: {
    defaultPort: 443,
    scheme: { default: "https" },
    user: { label: "API key" },
    hint: "OPNsense: System > Access > Users, edit a user (a dedicated one is best) and create an API key. Give it read access to the dashboard, DHCP, gateways and firmware, and to Firewall: Alias: Edit for blocking.",
  },
  credential: {
    secretName: "opnsense-api-secret",
    type: "password",
    arg: "password",
    label: "API secret",
    hint: "The secret shown with the key (in the downloaded apikey.txt).",
    tools: ["opnsense_status", "opnsense_block"],
  },
  test: { op: "status", describe: describeStatus("OPNsense") },
  ops: { status: { tool: "opnsense_status" } },
  features: features(() => OPNSENSE),
  options: lossOption,
  agentTools: ["opnsense_status", "opnsense_block"],
};

export const PFSENSE: IntegrationDef = {
  key: "pfsense",
  name: "pfSense",
  description: "Watch your gateways, name devices from DHCP, and let agents block a device through a change. Needs the pfSense REST API package.",
  plan: "free",
  connection: {
    defaultPort: 443,
    scheme: { default: "https" },
    hint: "pfSense has no API of its own: install the pfSense REST API package (pfrest, from github.com/jaredhendrickson13/pfsense-api), then System > REST API > Keys to create a key.",
  },
  credential: {
    secretName: "pfsense-api-key",
    type: "api_token",
    arg: "apiKey",
    label: "REST API key",
    hint: "From System > REST API > Keys, for a user with read access (and alias edit, for blocking).",
    tools: ["pfsense_status", "pfsense_block"],
  },
  test: { op: "status", describe: describeStatus("pfSense") },
  ops: { status: { tool: "pfsense_status" } },
  features: features(() => PFSENSE),
  options: lossOption,
  agentTools: ["pfsense_status", "pfsense_block"],
};
