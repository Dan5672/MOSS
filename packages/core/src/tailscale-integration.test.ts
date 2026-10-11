// Tailscale devices as health and inventory.
import { describe, expect, it } from "vitest";
import { parseIntegrationConfig } from "./integrations/config.js";
import { TAILSCALE, tailscaleHealth, tailscaleInventory } from "./integrations/tailscale.js";

const now = new Date("2030-01-10T00:00:00Z");
const device = (over: Record<string, unknown>) => ({ id: "n1", name: "nas", addresses: ["100.64.0.5"], lanAddresses: ["192.168.1.10"], tags: [], online: true, keyExpiryDisabled: false, expires: "2030-06-01T00:00:00Z", updateAvailable: false, ...over });

describe("Tailscale", () => {
  it("watches tagged devices only, and keys about to expire", () => {
    const out = tailscaleHealth(
      {
        devices: [
          device({ id: "n1", name: "nas", tags: ["tag:server"], online: false, lastSeen: "2030-01-09T22:00:00Z" }),
          device({ id: "n2", name: "phone", online: false }),
          device({ id: "n3", name: "laptop", expires: "2030-01-15T00:00:00Z", updateAvailable: true }),
          device({ id: "n4", name: "pi", keyExpiryDisabled: true, expires: "2030-01-01T00:00:00Z" }),
        ],
      },
      parseIntegrationConfig(TAILSCALE, {}),
      now,
    );
    expect(out.alerts!.map((a) => [a.name, a.status, a.message])).toEqual([
      ["nas on Tailscale", "down", "Offline since 2030-01-09T22:00:00Z"],
      ["Tailscale node keys", "degraded", "laptop expires in 5 days"],
    ]);
    expect(out.summary).toBe("2 of 4 device(s) online; updates for laptop");
  });

  it("matches devices by their local addresses, keeping the Tailscale address", () => {
    expect(tailscaleInventory({ devices: [device({ os: "linux", dnsName: "nas.tail.ts.net" })] }).inventory).toEqual([
      { externalId: "n1", name: "nas", os: "linux", ips: ["192.168.1.10"], macs: [], details: { tailscaleAddress: "100.64.0.5", dnsName: "nas.tail.ts.net", tags: [], user: undefined } },
    ]);
  });
});
