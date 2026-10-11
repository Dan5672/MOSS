// Cloudflare: what's public, and tunnels.
import { describe, expect, it } from "vitest";
import { CLOUDFLARE, exposureHealth, publicHostnames, tunnelHealth } from "./integrations/cloudflare.js";
import { parseIntegrationConfig } from "./integrations/config.js";

const dns = {
  zones: [
    {
      name: "example.com",
      records: [
        { type: "A", name: "home.example.com", content: "203.0.113.7", proxied: false },
        { type: "A", name: "moss.example.com", content: "10.0.0.213", proxied: false },
        { type: "CNAME", name: "ha.example.com", content: "abc.cfargotunnel.com", proxied: true },
        { type: "A", name: "blog.example.com", content: "198.51.100.4", proxied: true },
        { type: "TXT", name: "example.com", content: "v=spf1", proxied: false },
      ],
    },
  ],
};

describe("Cloudflare", () => {
  it("finds what the internet can reach, and leaves private records out", () => {
    expect(publicHostnames(dns).map((h) => [h.name, h.via])).toEqual([
      ["blog.example.com", "proxied"],
      ["ha.example.com", "tunnel"],
      ["home.example.com", "public address"],
    ]);
  });

  it("is degraded while something new isn't marked as expected", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const fresh = exposureHealth(dns, parseIntegrationConfig(CLOUDFLARE, { options: { acknowledged: ["blog.example.com", "ha.example.com"] } }), now);
    expect(fresh.alerts![0]).toMatchObject({ status: "degraded", value: 3 });
    expect(fresh.alerts![0]!.message).toMatch(/^New public hostname: home\.example\.com \(public address\)/);
    const known = exposureHealth(dns, parseIntegrationConfig(CLOUDFLARE, { options: { acknowledged: ["blog.example.com", "ha.example.com", "home.example.com"] } }), now);
    expect(known.alerts![0]).toMatchObject({ status: "up", message: "3 public hostname(s), all expected" });
    expect((known.state as { exposure: { hostnames: unknown[] } }).exposure.hostnames).toHaveLength(3);
  });

  it("watches tunnels", () => {
    expect(tunnelHealth({ tunnels: [{ id: "t1", name: "home", status: "healthy", connections: 4, hostnames: ["ha.example.com"] }, { id: "t2", name: "old", status: "down", connections: 0, hostnames: [] }] }).alerts!.map((a) => a.status)).toEqual(["up", "down"]);
  });
});
