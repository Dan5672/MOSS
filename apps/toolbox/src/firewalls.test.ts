// OPNsense and pfSense: leases, gateways and updates, and blocking through the moss_blocked alias.
import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";

function device(routes: Record<string, unknown | ((r: RenderedRequest) => unknown)>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    const json = typeof route === "function" ? (route as (r: RenderedRequest) => unknown)(r) : route;
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(json)), truncated: false };
  };
  return { send, seen };
}
const run = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);

describe("OPNsense", () => {
  it("reads leases from whichever DHCP server answers, gateways and updates", async () => {
    const { send, seen } = device({
      "GET /api/kea/leases4/search": { rows: [{ address: "10.0.0.50", hwaddr: "AA:BB:CC:00:00:50", hostname: "tv" }] },
      "GET /api/dhcpv4/leases/searchLease": { rows: [{ address: "10.0.0.51", mac: "aa:bb:cc:00:00:51", hostname: "printer" }, { address: "10.0.0.50", mac: "x" }] },
      "GET /api/routes/gateway/status": { items: [{ name: "WAN_DHCP", address: "203.0.113.1", status: "none", status_translated: "Online", loss: "0.0 %", delay: "8.4 ms" }, { name: "WAN2", status: "down", status_translated: "Offline", loss: "100.0 %", delay: "~" }] },
      "GET /api/core/firmware/status": { status: "update", status_msg: "There are 3 updates available", product: { product_version: "24.7.4" } },
    });
    const res = await run("opnsense_status", { target: "10.0.0.1", user: "key", password: "secret" }, send);
    expect(seen[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
    expect(res).toEqual({
      product: "opnsense",
      version: "24.7.4",
      leases: [
        { ip: "10.0.0.50", mac: "aa:bb:cc:00:00:50", hostname: "tv" },
        { ip: "10.0.0.51", mac: "aa:bb:cc:00:00:51", hostname: "printer" },
      ],
      gateways: [
        { name: "WAN_DHCP", address: "203.0.113.1", online: true, status: "Online", lossPercent: 0, delayMs: 8.4 },
        { name: "WAN2", address: undefined, online: false, status: "Offline", lossPercent: 100, delayMs: undefined },
      ],
      update: { available: true, message: "There are 3 updates available" },
    });
  });

  it("blocks through the alias, and explains a missing alias", async () => {
    const { send, seen } = device({
      "POST /api/firewall/alias_util/add/moss_blocked": { status: "done" },
      "GET /api/firewall/alias_util/list/moss_blocked": { rows: [{ ip: "10.0.0.66" }] },
      "POST /api/firewall/alias_util/add/missing": { status: "failed" },
    });
    expect(await run("opnsense_block", { target: "10.0.0.1", user: "key", password: "s", address: "10.0.0.66", action: "add" }, send)).toEqual({ alias: "moss_blocked", address: "10.0.0.66", action: "add", inAlias: true });
    expect(seen[0]!.body).toBe(JSON.stringify({ address: "10.0.0.66" }));
    await expect(run("opnsense_block", { target: "10.0.0.1", user: "key", password: "s", alias: "missing", address: "10.0.0.66", action: "add" }, send)).rejects.toThrow(/Create a Host\(s\) alias called missing/);
  });
});

describe("pfSense", () => {
  it("reads through the REST API package, and says when it isn't installed", async () => {
    const { send, seen } = device({
      "GET /api/v2/status/dhcp_server/leases": { data: [{ ip: "10.0.1.20", mac: "aa:bb:cc:00:01:20", hostname: "nas" }] },
      "GET /api/v2/status/gateways": { data: [{ name: "WAN", monitorip: "1.1.1.1", status: "online", loss: "0.0%", delay: "12.1ms" }] },
      "GET /api/v2/system/version": { data: { version: "2.7.2-RELEASE" } },
    });
    expect(await run("pfsense_status", { target: "10.0.1.1", apiKey: "k" }, send)).toEqual({
      product: "pfsense",
      version: "2.7.2-RELEASE",
      leases: [{ ip: "10.0.1.20", mac: "aa:bb:cc:00:01:20", hostname: "nas" }],
      gateways: [{ name: "WAN", address: "1.1.1.1", online: true, status: "online", lossPercent: 0, delayMs: 12.1 }],
    });
    expect(seen[0]!.headers["X-API-Key"]).toBe("k");
    await expect(run("pfsense_status", { target: "10.0.1.1", apiKey: "k" }, device({}).send)).rejects.toThrow(/install the pfSense REST API package/);
  });

  it("adds to the alias and applies", async () => {
    const { send, seen } = device({
      "GET /api/v2/firewall/aliases?name=moss_blocked": { data: [{ id: 4, name: "moss_blocked", address: ["10.0.1.9"] }] },
      "PATCH /api/v2/firewall/alias": {},
      "POST /api/v2/firewall/apply": {},
    });
    expect(await run("pfsense_block", { target: "10.0.1.1", apiKey: "k", address: "10.0.1.66", action: "add" }, send)).toMatchObject({ inAlias: true });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v2/firewall/aliases?name=moss_blocked", "PATCH /api/v2/firewall/alias", "POST /api/v2/firewall/apply"]);
    expect(JSON.parse(seen[1]!.body!)).toEqual({ id: 4, address: ["10.0.1.9", "10.0.1.66"] });
  });
});
