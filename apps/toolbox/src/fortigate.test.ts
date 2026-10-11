// FortiGate: leases, SD-WAN links, IPsec tunnels and firmware, read-only, leaving out what the profile can't read.
import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";

function device(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const path = r.path.split("?")[0]!;
    if (status[path]) return { status: status[path]!, contentType: "application/json", body: Buffer.from("{}"), truncated: false };
    const json = routes[path];
    if (json === undefined) return { status: 404, contentType: "application/json", body: Buffer.from("{}"), truncated: false };
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(json)), truncated: false };
  };
  return { send, seen };
}
const run = (args: Record<string, unknown>, send: RawRequest) => runTool("fortigate_status", { target: "10.0.0.1", apiToken: "tok", ...args }, undefined, undefined, undefined, send);

describe("FortiGate", () => {
  it("reads links, tunnels, leases and firmware with the token", async () => {
    const { send, seen } = device({
      "/api/v2/monitor/system/status": { version: "v7.4.3", results: { hostname: "fw-office", model_name: "FortiGate-60F" } },
      "/api/v2/monitor/system/dhcp": { results: [{ ip: "10.0.0.50", mac: "AA:BB:CC:00:00:50", hostname: "reception-pc" }, { ip: "10.0.0.50", mac: "x" }] },
      "/api/v2/monitor/virtual-wan/health-check": { results: { Internet: { wan1: { status: "up", latency: 8.37, packet_loss: 0 }, wan2: { status: "down", packet_loss: 100 } } } },
      "/api/v2/monitor/vpn/ipsec": { results: [{ name: "to-branch", rgwy: "198.51.100.9", proxyid: [{ status: "up" }, { status: "down" }] }, { name: "old", proxyid: [{ status: "down" }] }] },
      "/api/v2/monitor/system/firmware": { results: { current: { version: "v7.4.3" }, available: [{ version: "v7.4.5" }] } },
    });
    const res = await run({ vdom: "root" }, send);
    expect(seen[0]!.headers.Authorization).toBe("Bearer tok");
    expect(seen[0]!.path).toBe("/api/v2/monitor/system/status?vdom=root");
    expect(res).toMatchObject({
      version: "v7.4.3",
      hostname: "fw-office",
      model: "FortiGate-60F",
      leases: [{ ip: "10.0.0.50", mac: "aa:bb:cc:00:00:50", hostname: "reception-pc" }],
      gateways: [
        { name: "Internet/wan1", online: true, status: "up", lossPercent: 0, delayMs: 8.4 },
        { name: "Internet/wan2", online: false, status: "down", lossPercent: 100 },
      ],
      tunnels: [
        { name: "to-branch", remote: "198.51.100.9", up: true, selectorsUp: 1, selectors: 2 },
        { name: "old", up: false, selectorsUp: 0, selectors: 1 },
      ],
      update: { available: true, message: "FortiOS v7.4.5 is available (running v7.4.3)" },
    });
  });

  it("leaves out sections the profile can't read, and explains a refused token", async () => {
    const partial = device({ "/api/v2/monitor/system/status": { version: "v7.4.3", results: {} } }, { "/api/v2/monitor/vpn/ipsec": 403 });
    expect(await run({}, partial.send)).toMatchObject({ tunnels: [], gateways: [], leases: [] });
    const refused = device({}, { "/api/v2/monitor/system/status": 403 });
    await expect(run({}, refused.send)).rejects.toThrow(/Trusted Hosts/);
  });
});
