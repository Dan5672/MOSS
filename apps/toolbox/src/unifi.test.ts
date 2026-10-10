import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";

type Reply = { status?: number; json?: unknown; headers?: Record<string, string | string[]> };

/** A fake UniFi console: answers by "METHOD path" and records every request. */
function console_(routes: Record<string, Reply | ((r: RenderedRequest) => Reply)>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    const a = typeof route === "function" ? route(r) : route;
    return { status: a.status ?? 200, body: Buffer.from(JSON.stringify(a.json ?? {})), truncated: false, headers: a.headers ?? {} };
  };
  return { send, seen };
}

const run = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);
const login = { controller: "10.0.0.138", username: "moss", password: "hunter2-but-longer" };
const LOGIN_OK: Reply = { json: {}, headers: { "set-cookie": ["TOKEN=abc123; path=/; HttpOnly", "other=x; path=/"], "x-csrf-token": "csrf-1" } };

describe("UniFi sign-in", () => {
  it("signs in to a UniFi OS console with a local account, uses the session, and signs out", async () => {
    const { send, seen } = console_({
      "POST /api/auth/login": LOGIN_OK,
      "GET /proxy/network/api/s/default/stat/sta": { json: { meta: { rc: "ok" }, data: [{ ip: "10.0.0.50", mac: "AA:BB:CC:DD:EE:FF", hostname: "tv", is_wired: false }] } },
      "POST /api/auth/logout": { json: {} },
    });
    const res = await run("unifi_clients", login, send);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ username: "moss", password: "hunter2-but-longer", rememberMe: false });
    expect(seen[1]!.headers).toMatchObject({ Cookie: "TOKEN=abc123; other=x", "X-CSRF-Token": "csrf-1" });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/auth/login", "GET /proxy/network/api/s/default/stat/sta", "POST /api/auth/logout"]);
    expect(res).toEqual({
      site: "default",
      clients: [{ ip: "10.0.0.50", mac: "aa:bb:cc:dd:ee:ff", name: "tv", type: "wireless", connectedAt: undefined, uplinkDevice: undefined }],
      hosts: [{ ip: "10.0.0.50", mac: "aa:bb:cc:dd:ee:ff", hostnames: ["tv"], status: "up" }],
    });
    // The password only ever goes in the sign-in body.
    expect(seen.slice(1).some((r) => JSON.stringify(r).includes("hunter2"))).toBe(false);
  });

  it("falls back to a self-hosted Network application's sign-in", async () => {
    const { send, seen } = console_({
      "POST /api/login": { json: { meta: { rc: "ok" } }, headers: { "set-cookie": ["unifises=s1; path=/", "csrf_token=c1; path=/"] } },
      "GET /api/s/default/stat/sta": { json: { meta: { rc: "ok" }, data: [] } },
      "POST /api/logout": { json: {} },
    });
    await run("unifi_clients", { ...login, port: 8443 }, send);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/auth/login", "POST /api/login", "GET /api/s/default/stat/sta", "POST /api/logout"]);
    expect(seen[2]!.headers).toMatchObject({ Cookie: "unifises=s1; csrf_token=c1", "X-CSRF-Token": "c1" });
  });

  it("a rejected password says to use a local account", async () => {
    const { send } = console_({ "POST /api/auth/login": { status: 401, json: {} } });
    await expect(run("unifi_clients", login, send)).rejects.toThrow(/local account/);
  });

  it("needs exactly one way to sign in", async () => {
    const { send } = console_({});
    await expect(run("unifi_clients", { controller: "10.0.0.138" }, send)).rejects.toThrow(/API key .* or a local account/);
    await expect(run("unifi_firewall", { ...login, apiKey: "k" }, send)).rejects.toThrow(/not both/);
  });

  it("write tools sign in too", async () => {
    const { send, seen } = console_({
      "POST /api/auth/login": LOGIN_OK,
      "POST /proxy/network/api/s/default/cmd/stamgr": { json: { meta: { rc: "ok" }, data: [] } },
      "GET /proxy/network/api/s/default/stat/user/aa:bb:cc:dd:ee:ff": { json: { meta: { rc: "ok" }, data: [{ blocked: true, name: "tv" }] } },
      "POST /api/auth/logout": { json: {} },
    });
    expect(await run("unifi_client_block", { ...login, mac: "aa:bb:cc:dd:ee:ff", action: "block" }, send)).toMatchObject({ blocked: true });
    expect(seen.filter((r) => r.path === "/api/auth/login")).toHaveLength(2); // one session per call
  });
});

describe("unifi_firewall", () => {
  const networks = { json: { meta: { rc: "ok" }, data: [{ _id: "n1", name: "Default", purpose: "corporate", ip_subnet: "10.0.0.1/24" }, { _id: "n2", name: "IOT", purpose: "corporate", ip_subnet: "10.0.30.1/24", vlan: 30 }] } };
  const groups = { json: { meta: { rc: "ok" }, data: [{ _id: "g1", name: "Gateway admin ports", group_members: ["80", "443", "8080", "8443"] }] } };
  const forwards = { json: { meta: { rc: "ok" }, data: [{ name: "Plex", enabled: true, proto: "tcp", dst_port: "32400", fwd: "10.0.0.20", fwd_port: "32400" }] } };

  it("zone-based policies, with network and zone names", async () => {
    const { send } = console_({
      "POST /api/auth/login": LOGIN_OK,
      "POST /api/auth/logout": { json: {} },
      "GET /proxy/network/api/s/default/rest/networkconf": networks,
      "GET /proxy/network/api/s/default/rest/firewallgroup": groups,
      "GET /proxy/network/v2/api/site/default/firewall/zone": { json: [{ _id: "z1", name: "Internal" }, { _id: "z2", name: "Gateway" }, { _id: "z3", name: "IoT" }] },
      "GET /proxy/network/v2/api/site/default/firewall-policies": {
        json: [
          { name: "Block IoT to Default", enabled: true, action: "BLOCK", index: 10000, protocol: "all", source: { zone_id: "z3", matching_target: "ANY" }, destination: { zone_id: "z1", matching_target: "NETWORK", network_ids: ["n1"] } },
          { name: "Allow all", predefined: true, action: "ALLOW", index: 1, source: { zone_id: "z1" }, destination: { zone_id: "z2" } },
        ],
      },
      "GET /proxy/network/api/s/default/rest/firewallrule": { json: { meta: { rc: "ok" }, data: [] } },
      "GET /proxy/network/api/s/default/rest/portforward": forwards,
    });
    const res = (await run("unifi_firewall", login, send)) as Record<string, unknown>;
    expect(res.firewall).toBe("zone-based");
    expect(res.policies).toEqual([
      { name: "Block IoT to Default", enabled: true, action: "block", protocol: "all", from: { zone: "IoT", match: "ANY" }, to: { zone: "Internal", match: "NETWORK", values: ["Default"] } },
    ]);
    expect(res.builtInHidden).toBe(1);
    expect(res.networks).toContainEqual({ name: "IOT", purpose: "corporate", subnet: "10.0.30.1/24", vlan: 30, enabled: true });
    expect(res.portForwards).toEqual([{ name: "Plex", enabled: true, protocol: "tcp", port: "32400", to: "10.0.0.20:32400", from: "any" }]);
  });

  it("classic firewall rules on older versions, with an API key", async () => {
    const { send, seen } = console_({
      "GET /proxy/network/api/s/default/rest/networkconf": networks,
      "GET /proxy/network/api/s/default/rest/firewallgroup": groups,
      "GET /proxy/network/api/s/default/rest/firewallrule": {
        json: {
          meta: { rc: "ok" },
          data: [{ name: "IOT no admin", enabled: true, ruleset: "LAN_LOCAL", rule_index: 2000, action: "drop", protocol: "tcp", src_networkconf_id: "n2", dst_firewallgroup_ids: ["g1"] }],
        },
      },
      "GET /proxy/network/api/s/default/rest/portforward": forwards,
    });
    const res = (await run("unifi_firewall", { controller: "10.0.0.138", apiKey: "key-1" }, send)) as Record<string, unknown>;
    expect(seen.every((r) => r.headers["X-API-KEY"] === "key-1")).toBe(true);
    expect(res.firewall).toBe("rules");
    expect(res.rules).toEqual([{ name: "IOT no admin", enabled: true, ruleset: "LAN_LOCAL", index: 2000, action: "drop", protocol: "tcp", from: { network: "IOT" }, to: { groups: ["Gateway admin ports"] } }]);
    expect(res.groups).toEqual([{ name: "Gateway admin ports", members: ["80", "443", "8080", "8443"] }]);
  });
});
