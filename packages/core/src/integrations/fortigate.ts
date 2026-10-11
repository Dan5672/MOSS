// Fortinet FortiGate (business), read-only: SD-WAN links watched like gateways, IPsec tunnels, firmware updates,
// and device names from DHCP. It reuses the OPNsense and pfSense health and inventory for links and leases.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { firewallHealth, firewallInventory, type FirewallStatus } from "./firewalls.js";
import type { FeatureOutput, IntegrationConfig, IntegrationDef } from "./types.js";

interface FortiStatus extends FirewallStatus {
  hostname?: string;
  model?: string;
  tunnels: { name: string; remote?: string; up: boolean; selectorsUp: number; selectors: number }[];
}

export function fortigateHealth(r: FortiStatus, c: IntegrationConfig): FeatureOutput {
  const base = firewallHealth(FORTIGATE, r, c);
  const tunnels: ParsedAlert[] = r.tunnels.map((t) => ({
    key: `ipsec:${t.name}`,
    name: `FortiGate VPN ${t.name}`,
    status: !t.up ? "down" : t.selectorsUp < t.selectors ? "degraded" : "up",
    message: `${t.up ? "Up" : "Down"}${t.remote ? ` to ${t.remote}` : ""}: ${t.selectorsUp} of ${t.selectors} selector(s) up`,
  }));
  const firmware: ParsedAlert = {
    key: "firmware",
    name: "FortiGate firmware",
    status: r.update?.available ? "degraded" : "up",
    message: r.update?.available ? (r.update.message ?? "A FortiOS update is available") : `FortiOS ${r.version ?? ""} is current`.trim(),
  };
  const down = r.tunnels.filter((t) => !t.up).length;
  return { alerts: [...(base.alerts ?? []), ...tunnels, firmware], summary: `${base.summary} ${r.tunnels.length - down} of ${r.tunnels.length} VPN tunnel(s) up.` };
}

export const FORTIGATE: IntegrationDef = {
  key: "fortigate",
  name: "FortiGate",
  description: "Watch your SD-WAN links and VPN tunnels, see when FortiOS has an update, and name devices from DHCP. Read-only.",
  plan: "business",
  connection: {
    defaultPort: 443,
    scheme: { default: "https" },
    hint: "FortiGate: System > Administrators > Create New > REST API Admin, with a read-only admin profile and MOSS's address in Trusted Hosts. Copy the token it shows once.",
  },
  credential: {
    secretName: "fortigate-api-token",
    type: "api_token",
    arg: "apiToken",
    label: "REST API token",
    hint: "Shown once when you create the REST API admin.",
    tools: ["fortigate_status"],
  },
  test: {
    op: "status",
    describe: (r) => {
      const s = r as FortiStatus;
      return `Connected to ${s.hostname ?? "the FortiGate"} (${s.model ?? "FortiGate"}, FortiOS ${s.version ?? "?"}): ${s.gateways.length} SD-WAN link check(s), ${s.tunnels.length} VPN tunnel(s), ${s.leases.length} DHCP lease(s).`;
    },
  },
  ops: { status: { tool: "fortigate_status" } },
  features: [
    {
      key: "health",
      label: "Link, VPN and firmware checks",
      description: "Every 5 minutes: each SD-WAN link (down, or degraded on packet loss, with latency as a reading), each IPsec tunnel, and whether a FortiOS update is available.",
      everyMs: 5 * 60_000,
      op: "status",
      apply: (r, { config }) => fortigateHealth(r as FortiStatus, config),
    },
    {
      key: "inventory",
      label: "Device names from DHCP",
      description: "Every hour: the FortiGate's DHCP leases name devices in the inventory.",
      everyMs: 60 * 60_000,
      op: "status",
      apply: (r) => firewallInventory(r as FortiStatus),
    },
  ],
  options: [{ key: "lossWarn", label: "Link degraded at (% packet loss)", default: 5, min: 1, max: 100 }],
  agentTools: ["fortigate_status"],
};
