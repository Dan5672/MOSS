// FortiGate and Meraki: what they put on monitors and in the inventory.
import { describe, expect, it } from "vitest";
import { parseIntegrationConfig } from "./integrations/config.js";
import { FORTIGATE, fortigateHealth } from "./integrations/fortigate.js";
import { MERAKI, merakiClients, merakiHealth, merakiInventory } from "./integrations/meraki.js";

describe("FortiGate", () => {
  it("watches SD-WAN links, VPN tunnels and firmware", () => {
    const out = fortigateHealth(
      {
        product: "opnsense",
        version: "v7.4.3",
        leases: [],
        gateways: [
          { name: "Internet/wan1", online: true, status: "up", lossPercent: 0, delayMs: 8 },
          { name: "Internet/wan2", online: false, status: "down" },
        ],
        tunnels: [
          { name: "to-branch", remote: "198.51.100.9", up: true, selectorsUp: 1, selectors: 2 },
          { name: "old", up: false, selectorsUp: 0, selectors: 1 },
        ],
        update: { available: true, message: "FortiOS v7.4.5 is available (running v7.4.3)" },
      },
      parseIntegrationConfig(FORTIGATE, {}),
    );
    expect(out.alerts!.map((a) => [a.key, a.status])).toEqual([
      ["gateway:Internet/wan1", "up"],
      ["gateway:Internet/wan2", "down"],
      ["ipsec:to-branch", "degraded"],
      ["ipsec:old", "down"],
      ["firmware", "degraded"],
    ]);
    expect(out.summary).toMatch(/1 of 2 VPN tunnel\(s\) up\.$/);
  });
});

describe("Cisco Meraki", () => {
  const devices = {
    organizations: ["Acme"],
    devices: [
      { serial: "Q2-MX", name: "Office MX", model: "MX68", type: "appliance", status: "online", mac: "aa:bb:cc:00:00:01", lanIp: "10.0.0.1", org: "Acme" },
      { serial: "Q2-AP", name: "Lobby AP", type: "wireless", status: "alerting", org: "Acme" },
      { serial: "Q2-CAM", name: "Old cam", type: "camera", status: "dormant", org: "Acme" },
    ],
    uplinks: [
      { serial: "Q2-MX", interface: "wan1", status: "active", lossPercent: 0.5, latencyMs: 220 },
      { serial: "Q2-MX", interface: "wan2", status: "failed" },
      { serial: "Q2-MX", interface: "cellular", status: "not connected" },
    ],
    vpnPeers: [{ network: "Office", peer: "Branch", reachable: false }],
  };

  it("watches devices, uplinks and VPN peers, skipping dormant gear and unplugged uplinks", () => {
    const out = merakiHealth(devices, parseIntegrationConfig(MERAKI, {}));
    expect(out.alerts!.map((a) => [a.key, a.status])).toEqual([
      ["device:Q2-MX", "up"],
      ["device:Q2-AP", "degraded"],
      ["uplink:Q2-MX:wan1", "degraded"],
      ["uplink:Q2-MX:wan2", "down"],
      ["vpn:Office:Branch", "down"],
    ]);
    expect(out.alerts![2]).toMatchObject({ name: "Meraki Office MX wan1", value: 220, unit: "ms" });
  });

  it("puts Meraki gear and clients in the inventory", () => {
    expect(merakiInventory(devices).inventory![0]).toMatchObject({ externalId: "serial:Q2-MX", kind: "router", vendor: "Cisco Meraki", ips: ["10.0.0.1"] });
    expect(merakiInventory(devices).inventory![1]).toMatchObject({ kind: "access-point" });
    expect(merakiClients({ clients: [{ mac: "aa:bb:cc:00:00:50", ip: "10.0.0.50", name: "Reception PC" }, { name: "nothing to match" }] }).inventory).toEqual([
      { externalId: "mac:aa:bb:cc:00:00:50", name: "Reception PC", ips: ["10.0.0.50"], macs: ["aa:bb:cc:00:00:50"], details: { network: undefined } },
    ]);
  });
});
