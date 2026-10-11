// OPNsense and pfSense results as gateway monitors and device names.
import { describe, expect, it } from "vitest";
import { parseIntegrationConfig } from "./integrations/config.js";
import { firewallHealth, firewallInventory, OPNSENSE } from "./integrations/firewalls.js";

const status = {
  product: "opnsense" as const,
  version: "24.7.4",
  leases: [
    { ip: "10.0.0.50", mac: "aa:bb:cc:00:00:50", hostname: "tv.lan" },
    { ip: "10.0.0.52" },
  ],
  gateways: [
    { name: "WAN", online: true, status: "Online", lossPercent: 0, delayMs: 8.4 },
    { name: "LTE", online: true, status: "Packetloss", lossPercent: 12, delayMs: 60 },
    { name: "WAN2", online: false, status: "Offline", lossPercent: 100 },
  ],
  update: { available: true, message: "There are 3 updates available" },
};

describe("OPNsense and pfSense", () => {
  it("turns gateways into monitors: degraded on packet loss, down offline", () => {
    const out = firewallHealth(OPNSENSE, status, parseIntegrationConfig(OPNSENSE, {}));
    expect(out.alerts!.map((a) => [a.name, a.status])).toEqual([
      ["OPNsense gateway WAN", "up"],
      ["OPNsense gateway LTE", "degraded"],
      ["OPNsense gateway WAN2", "down"],
    ]);
    expect(out.alerts![0]).toMatchObject({ value: 8.4, unit: "ms", values: { lossPercent: 0, delayMs: 8.4 } });
    expect(out.summary).toBe("OPNsense 24.7.4: 2 of 3 gateway(s) up, 2 DHCP lease(s). There are 3 updates available.");
  });

  it("names devices from DHCP leases", () => {
    expect(firewallInventory(status).inventory).toEqual([
      { externalId: "mac:aa:bb:cc:00:00:50", name: "tv", ips: ["10.0.0.50"], macs: ["aa:bb:cc:00:00:50"] },
      { externalId: "ip:10.0.0.52", name: undefined, ips: ["10.0.0.52"], macs: [] },
    ]);
  });
});
