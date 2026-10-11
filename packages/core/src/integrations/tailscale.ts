// Tailscale: the tailnet's devices. Health: a monitor per tagged device (servers; phones and laptops come and go),
// and one for node keys about to expire (a device that drops off the tailnet when its key runs out is a classic
// surprise). Inventory: devices matched to assets by the local addresses Tailscale sees for them, with their
// Tailscale address alongside.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef } from "./types.js";

interface Device {
  id: string;
  name: string;
  dnsName?: string;
  os?: string;
  addresses: string[];
  lanAddresses: string[];
  user?: string;
  tags: string[];
  online: boolean;
  lastSeen?: string;
  keyExpiryDisabled: boolean;
  expires?: string;
  updateAvailable: boolean;
  clientVersion?: string;
}

const days = (from: Date, to: string) => (Date.parse(to) - from.getTime()) / 86_400_000;

export function tailscaleHealth(r: { devices: Device[] }, c: IntegrationConfig, now: Date): FeatureOutput {
  const warnDays = integrationOption(TAILSCALE, c, "keyWarnDays");
  const alerts: ParsedAlert[] = r.devices
    .filter((d) => d.tags.length > 0)
    .map((d) => ({
      key: `device:${d.id}`,
      name: `${d.name} on Tailscale`,
      status: d.online ? "up" : "down",
      message: d.online ? `Connected (${d.addresses[0] ?? "no address"})` : `Offline${d.lastSeen ? ` since ${d.lastSeen}` : ""}`,
    }));
  const expiring = r.devices.filter((d) => !d.keyExpiryDisabled && d.expires && !d.expires.startsWith("0001") && days(now, d.expires) <= warnDays);
  const expired = expiring.filter((d) => days(now, d.expires!) <= 0);
  alerts.push({
    key: "keys",
    name: "Tailscale node keys",
    status: expired.length ? "down" : expiring.length ? "degraded" : "up",
    message: expiring.length
      ? expiring.map((d) => `${d.name} ${days(now, d.expires!) <= 0 ? "expired" : `expires in ${Math.ceil(days(now, d.expires!))} days`}`).join(", ")
      : `No keys expire within ${warnDays} days`,
  });
  const updates = r.devices.filter((d) => d.updateAvailable).map((d) => d.name);
  const online = r.devices.filter((d) => d.online).length;
  return { alerts, summary: `${online} of ${r.devices.length} device(s) online${updates.length ? `; updates for ${updates.slice(0, 6).join(", ")}${updates.length > 6 ? "…" : ""}` : ""}` };
}

export function tailscaleInventory(r: { devices: Device[] }): FeatureOutput {
  return {
    inventory: r.devices.map((d) => ({
      externalId: d.id,
      name: d.name,
      ...(d.os ? { os: d.os } : {}),
      ips: d.lanAddresses,
      macs: [],
      details: { tailscaleAddress: d.addresses.find((a) => a.startsWith("100.")), dnsName: d.dnsName, tags: d.tags, user: d.user },
    })),
  };
}

export const TAILSCALE: IntegrationDef = {
  key: "tailscale",
  name: "Tailscale",
  description: "Watch your servers on the tailnet and the node keys about to expire, and bring tailnet devices into the inventory.",
  plan: "free",
  connection: {
    defaultPort: 443,
    cloud: true,
    hint: "MOSS reads your tailnet from api.tailscale.com. To reach MOSS itself over Tailscale, see the getting started guide (the tailscale profile).",
  },
  credential: {
    secretName: "tailscale-api-key",
    type: "api_token",
    arg: "apiKey",
    label: "API access token",
    hint: "Tailscale admin console: Settings > Keys > Generate access token (tskey-api-...). They last up to 90 days; MOSS says when it stops working.",
    tools: ["tailscale_devices"],
  },
  test: {
    op: "devices",
    describe: (r) => {
      const d = (r as { devices: Device[] }).devices;
      return `Connected to Tailscale: ${d.length} device(s), ${d.filter((x) => x.online).length} online.`;
    },
  },
  ops: { devices: { tool: "tailscale_devices" } },
  features: [
    {
      key: "health",
      label: "Device and key checks",
      description: "Every 10 minutes: each tagged device (your servers) connected, and node keys expiring soon. Untagged devices (phones, laptops) may come and go.",
      everyMs: 10 * 60_000,
      op: "devices",
      apply: (r, { config, now }) => tailscaleHealth(r as { devices: Device[] }, config, now),
    },
    {
      key: "inventory",
      label: "Tailnet devices in the inventory",
      description: "Every 6 hours: devices matched to assets by the local addresses Tailscale sees, with their Tailscale address and tags.",
      everyMs: 6 * 60 * 60_000,
      op: "devices",
      apply: (r) => tailscaleInventory(r as { devices: Device[] }),
    },
  ],
  options: [{ key: "keyWarnDays", label: "Warn when a key expires within (days)", default: 14, min: 1, max: 90 }],
  agentTools: ["tailscale_devices"],
};
