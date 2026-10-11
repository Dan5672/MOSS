// Cisco Meraki (business), read-only: a monitor per device (offline is down, alerting is degraded), per appliance
// uplink (failed is down; loss or latency over the limits is degraded) and per site-to-site VPN peer; Meraki gear and
// the clients each network has seen in the inventory.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef } from "./types.js";

interface Devices {
  organizations: string[];
  devices: { serial: string; name: string; model?: string; type?: string; status: string; mac?: string; lanIp?: string; publicIp?: string; org: string }[];
  uplinks: { serial: string; interface: string; status: string; ip?: string; lossPercent?: number; latencyMs?: number }[];
  vpnPeers: { network: string; peer: string; reachable: boolean }[];
}
interface Network {
  clients: { id?: string; mac?: string; ip?: string; name?: string; vendor?: string; os?: string; network?: string }[];
}

const KIND: Record<string, string> = { appliance: "router", switch: "switch", wireless: "access-point", camera: "camera", sensor: "iot", cellularGateway: "router" };

export function merakiHealth(r: Devices, c: IntegrationConfig): FeatureOutput {
  const lossWarn = integrationOption(MERAKI, c, "lossWarn");
  const latencyWarn = integrationOption(MERAKI, c, "latencyWarn");
  const names = new Map(r.devices.map((d) => [d.serial, d.name]));
  const alerts: ParsedAlert[] = [
    ...r.devices
      .filter((d) => d.status !== "dormant")
      .map((d) => ({
        key: `device:${d.serial}`,
        name: `Meraki ${d.name}`,
        status: (d.status === "offline" ? "down" : d.status === "alerting" ? "degraded" : "up") as ParsedAlert["status"],
        message: `${d.status}${d.model ? ` (${d.model})` : ""}`,
      })),
    ...r.uplinks
      .filter((u) => u.status !== "not connected")
      .map((u) => {
        const slow = (u.lossPercent ?? 0) >= lossWarn || (u.latencyMs ?? 0) >= latencyWarn;
        return {
          key: `uplink:${u.serial}:${u.interface}`,
          name: `Meraki ${names.get(u.serial) ?? u.serial} ${u.interface}`,
          status: (u.status === "failed" ? "down" : slow ? "degraded" : "up") as ParsedAlert["status"],
          message: `${u.status}${u.latencyMs !== undefined ? `, ${Math.round(u.latencyMs)} ms` : ""}${u.lossPercent !== undefined ? `, ${u.lossPercent}% loss` : ""}`,
          ...(u.latencyMs !== undefined ? { value: Math.round(u.latencyMs), unit: "ms" } : {}),
          values: Object.fromEntries(Object.entries({ lossPercent: u.lossPercent, latencyMs: u.latencyMs }).filter(([, v]) => typeof v === "number")) as Record<string, number>,
        };
      }),
    ...r.vpnPeers.map((v) => ({
      key: `vpn:${v.network}:${v.peer}`,
      name: `Meraki VPN ${v.network} to ${v.peer}`,
      status: (v.reachable ? "up" : "down") as ParsedAlert["status"],
      message: v.reachable ? "Reachable" : "Unreachable",
    })),
  ];
  const offline = r.devices.filter((d) => d.status === "offline").length;
  return { alerts, summary: `${r.devices.length - offline} of ${r.devices.length} device(s) online in ${r.organizations.join(", ") || "no organisation"}` };
}

export function merakiInventory(r: Devices & Partial<Network>): FeatureOutput {
  return {
    inventory: [
      ...r.devices.map((d) => ({
        externalId: `serial:${d.serial}`,
        name: d.name,
        kind: KIND[d.type ?? ""] ?? "network",
        vendor: "Cisco Meraki",
        ...(d.model ? { model: d.model } : {}),
        ips: d.lanIp ? [d.lanIp] : [],
        macs: d.mac ? [d.mac] : [],
        details: { serial: d.serial, status: d.status, publicIp: d.publicIp, organisation: d.org },
      })),
    ],
  };
}

export function merakiClients(r: Network): FeatureOutput {
  return {
    inventory: r.clients
      .filter((c) => c.mac || c.ip)
      .map((c) => ({
        externalId: c.mac ? `mac:${c.mac}` : `ip:${c.ip}`,
        ...(c.name ? { name: c.name } : {}),
        ...(c.vendor ? { vendor: c.vendor } : {}),
        ...(c.os ? { os: c.os } : {}),
        ips: c.ip ? [c.ip] : [],
        macs: c.mac ? [c.mac] : [],
        details: { network: c.network },
      })),
    summary: `${r.clients.length} client(s) seen`,
  };
}

export const MERAKI: IntegrationDef = {
  key: "meraki",
  name: "Cisco Meraki",
  description: "Watch your Meraki devices, uplinks and site-to-site VPN, and bring Meraki gear and the clients it sees into the inventory. Read-only.",
  plan: "business",
  connection: {
    defaultPort: 443,
    cloud: true,
    hint: "MOSS reads api.meraki.com. In the Meraki dashboard, give a dedicated account Read-only organisation access, sign in as it, and generate an API key in My Profile.",
  },
  credential: {
    secretName: "meraki-api-key",
    type: "api_token",
    arg: "apiKey",
    label: "Dashboard API key",
    hint: "From an account with read-only organisation access, so MOSS can't change anything.",
    tools: ["meraki_devices", "meraki_network"],
  },
  test: {
    op: "devices",
    describe: (r) => {
      const d = r as Devices;
      return `Connected to Meraki (${d.organizations.join(", ")}): ${d.devices.length} device(s), ${d.uplinks.length} uplink(s), ${d.vpnPeers.length} VPN peer(s).`;
    },
  },
  ops: { devices: { tool: "meraki_devices" }, network: { tool: "meraki_network" } },
  features: [
    {
      key: "health",
      label: "Device, uplink and VPN checks",
      description: "Every 5 minutes: each device online (down offline, degraded alerting), each appliance uplink (with loss and latency as readings) and each VPN peer.",
      everyMs: 5 * 60_000,
      op: "devices",
      apply: (r, { config }) => merakiHealth(r as Devices, config),
    },
    {
      key: "inventory",
      label: "Meraki devices in the inventory",
      description: "Every 6 hours: Meraki appliances, switches, access points and cameras, with model and serial.",
      everyMs: 6 * 60 * 60_000,
      op: "devices",
      apply: (r) => merakiInventory(r as Devices),
    },
    {
      key: "clients",
      label: "Client names from Meraki",
      description: "Every 6 hours: the clients each network has seen in the last day name devices in the inventory.",
      everyMs: 6 * 60 * 60_000,
      op: "network",
      apply: (r) => merakiClients(r as Network),
    },
  ],
  options: [
    { key: "lossWarn", label: "Uplink degraded at (% packet loss)", default: 5, min: 1, max: 100 },
    { key: "latencyWarn", label: "Uplink degraded at (ms latency)", default: 150, min: 10, max: 5000 },
  ],
  agentTools: ["meraki_devices", "meraki_network"],
};
