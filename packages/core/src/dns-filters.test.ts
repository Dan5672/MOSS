// Pi-hole and AdGuard Home results as health and inventory.
import { describe, expect, it } from "vitest";
import { adguardHealth, adguardInventory, piholeHealth, piholeInventory } from "./integrations/dns-filters.js";

describe("Pi-hole", () => {
  it("reports blocking with the day's readings, and a paused blocker as degraded", () => {
    const on = piholeHealth({ blocking: "enabled", queries: 50000, blocked: 6000, blockedPercent: 12.04, activeClients: 19 });
    expect(on.alerts![1]).toEqual({
      key: "blocking",
      name: "Pi-hole blocking",
      status: "up",
      message: "Blocking 12% of 50000 queries today",
      value: 12,
      unit: "%",
      values: { queries: 50000, blocked: 6000, blockedPercent: 12, activeClients: 19 },
    });
    expect(piholeHealth({ blocking: "disabled" }).alerts![1]).toMatchObject({ status: "degraded", message: "Blocking is paused" });
    expect(piholeHealth({ blocking: "failed" }).alerts![1]).toMatchObject({ status: "down", message: "Blocking is failed" });
  });

  it("lists devices by MAC (or address), without the local domain in their names", () => {
    expect(
      piholeInventory({
        devices: [
          { mac: "aa:bb:cc:11:22:33", vendor: "Synology", name: "nas.lan", ips: ["10.0.0.5"] },
          { ips: ["10.0.0.99"] },
          { ips: [] },
        ],
      }).inventory,
    ).toEqual([
      { externalId: "mac:aa:bb:cc:11:22:33", name: "nas", vendor: "Synology", ips: ["10.0.0.5"], macs: ["aa:bb:cc:11:22:33"] },
      { externalId: "ip:10.0.0.99", name: undefined, vendor: undefined, ips: ["10.0.0.99"], macs: [] },
    ]);
  });
});

describe("AdGuard Home", () => {
  it("reports protection, off as degraded", () => {
    expect(adguardHealth({ version: "v0.107", protectionEnabled: true, queries: 2000, blockedPercent: 25, avgProcessingMs: 12.3 }).alerts![1]).toMatchObject({
      status: "up",
      value: 25,
      values: { queries: 2000, blockedPercent: 25, avgProcessingMs: 12.3 },
    });
    expect(adguardHealth({ protectionEnabled: false }).alerts![1]).toMatchObject({ status: "degraded", message: "Protection is off" });
  });

  it("lists clients with an address or MAC", () => {
    expect(
      adguardInventory({
        clients: [
          { name: "Printer", macs: ["aa:bb:cc:00:11:22"], ips: ["10.0.0.30"], configured: true },
          { name: "laptop.lan", macs: [], ips: ["10.0.0.31"], configured: false },
          { name: "by-id", macs: [], ips: [], configured: true },
        ],
      }).inventory!.map((i) => [i.externalId, i.name]),
    ).toEqual([
      ["mac:aa:bb:cc:00:11:22", "Printer"],
      ["ip:10.0.0.31", "laptop"],
    ]);
  });
});
