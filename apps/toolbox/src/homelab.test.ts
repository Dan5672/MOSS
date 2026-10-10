import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";

/** A fake device: answers by "METHOD path" and records every request. */
function device(routes: Record<string, unknown | ((r: RenderedRequest) => unknown)>, status = 200) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    if (status !== 200) return { status, contentType: "application/json", body: Buffer.from("{}"), truncated: false };
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    const json = typeof route === "function" ? (route as (r: RenderedRequest) => unknown)(r) : route;
    return { status, contentType: "application/json", body: Buffer.from(JSON.stringify(json)), truncated: false };
  };
  return { send, seen };
}

const run = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);

describe("home lab integrations", () => {
  it("proxmox_status: sends the API token and summarises nodes, guests and storage", async () => {
    const { send, seen } = device({
      "GET /api2/json/cluster/resources": {
        data: [
          { type: "node", node: "pve1", status: "online", cpu: 0.125, mem: 8e9, maxmem: 32e9, disk: 10e9, maxdisk: 100e9, uptime: 864000 },
          { type: "qemu", vmid: 100, name: "homeassistant", node: "pve1", status: "running", cpu: 0.02, mem: 2e9, maxmem: 4e9 },
          { type: "lxc", vmid: 101, name: "pihole", node: "pve1", status: "stopped" },
          { type: "storage", storage: "local-zfs", node: "pve1", status: "available", disk: 450e9, maxdisk: 500e9 },
        ],
      },
    });
    const res = (await run("proxmox_status", { target: "10.0.0.10", token: "moss@pve!ro=0b1c-uuid" }, send)) as Record<string, unknown[]>;
    expect(seen[0]).toMatchObject({ port: 8006, scheme: "https", verifyTls: false, headers: expect.objectContaining({ Authorization: "PVEAPIToken=moss@pve!ro=0b1c-uuid" }) });
    expect(res.nodes).toEqual([{ node: "pve1", status: "online", cpuPercent: 12.5, memoryPercent: 25, diskPercent: 10, uptimeDays: 10 }]);
    expect(res.guests).toEqual([
      { id: 100, name: "homeassistant", kind: "vm", node: "pve1", status: "running", cpuPercent: 2, memoryPercent: 50 },
      { id: 101, name: "pihole", kind: "container", node: "pve1", status: "stopped", cpuPercent: undefined, memoryPercent: undefined },
    ]);
    expect(res.storage).toEqual([{ storage: "local-zfs", node: "pve1", status: "available", usedPercent: 90, sizeGb: 500 }]);
    await expect(run("proxmox_status", { target: "10.0.0.10", token: "not-a-token" }, send)).rejects.toThrow(/USER@REALM!TOKENID=SECRET/);
  });

  it("truenas_status: pools, undismissed alerts and system info", async () => {
    const { send, seen } = device({
      "GET /api/v2.0/system/info": { hostname: "truenas", version: "TrueNAS-SCALE-24.10", uptime_seconds: 172800 },
      "GET /api/v2.0/pool": [{ name: "tank", status: "DEGRADED", healthy: false }],
      "GET /api/v2.0/alert/list": [
        { level: "CRITICAL", formatted: "Pool tank state is DEGRADED", dismissed: false },
        { level: "INFO", formatted: "old", dismissed: true },
      ],
    });
    const res = await run("truenas_status", { target: "10.0.0.11", apiKey: "1-abc" }, send);
    expect(seen.every((r) => r.headers.Authorization === "Bearer 1-abc")).toBe(true);
    expect(res).toEqual({
      hostname: "truenas",
      version: "TrueNAS-SCALE-24.10",
      uptimeDays: 2,
      pools: [{ name: "tank", status: "DEGRADED", healthy: false }],
      alerts: [{ level: "CRITICAL", message: "Pool tank state is DEGRADED" }],
    });
  });

  it("synology_status: logs in, reads system and storage, and always logs out", async () => {
    const calls: string[] = [];
    const { send } = device({
      "POST /webapi/entry.cgi": (r: RenderedRequest) => {
        const f = new URLSearchParams(r.body);
        calls.push(`${f.get("api")}.${f.get("method")}`);
        if (f.get("method") === "login") return f.get("passwd") === "pw" ? { success: true, data: { sid: "SID1" } } : { success: false };
        expect(f.get("_sid")).toBe("SID1");
        if (f.get("api") === "SYNO.Core.System") return { success: true, data: { model: "DS920+", firmware_ver: "DSM 7.2", sys_temp: 41 } };
        if (f.get("api") === "SYNO.Storage.CGI.Storage")
          return { success: true, data: { volumes: [{ id: "volume_1", status: "normal", size: { total: "8000000000000", used: "6000000000000" } }], disks: [{ id: "sata1", name: "Drive 1", status: "normal", smart_status: "normal", temp: 35 }] } };
        return { success: true };
      },
    });
    const res = (await run("synology_status", { target: "10.0.0.12", user: "moss", password: "pw" }, send)) as Record<string, unknown>;
    expect(res).toMatchObject({ model: "DS920+", temperatureC: 41, volumes: [{ id: "volume_1", status: "normal", usedPercent: 75, sizeGb: 8000 }] });
    expect(calls.at(-1)).toBe("SYNO.API.Auth.logout");
    await expect(run("synology_status", { target: "10.0.0.12", user: "moss", password: "wrong" }, send)).rejects.toThrow(/refused the login/);
  });

  it("homeassistant_states: filters by domain and limits the list", async () => {
    const { send, seen } = device({
      "GET /api/states": [
        { entity_id: "sensor.ups_battery", state: "100", attributes: { friendly_name: "UPS battery", unit_of_measurement: "%" }, last_changed: "2026-10-06T00:00:00Z" },
        { entity_id: "switch.modem_plug", state: "on", attributes: { friendly_name: "Modem plug" } },
      ],
    });
    const res = await run("homeassistant_states", { target: "10.0.0.13", token: "llat", domain: "sensor" }, send);
    expect(seen[0]).toMatchObject({ port: 8123, scheme: "http", headers: expect.objectContaining({ Authorization: "Bearer llat" }) });
    expect(res).toEqual({ total: 1, entities: [{ entity: "sensor.ups_battery", name: "UPS battery", state: "100", unit: "%", changed: "2026-10-06T00:00:00Z" }] });
  });

  it("homeassistant_states: reads one entity from its own endpoint", async () => {
    const { send } = device({
      "GET /api/states/sensor.ups_load": { entity_id: "sensor.ups_load", state: "23.5", attributes: { friendly_name: "UPS load", unit_of_measurement: "%" } },
    });
    const res = await run("homeassistant_states", { target: "10.0.0.13", token: "llat", entity: "sensor.ups_load" }, send);
    expect(res).toMatchObject({ total: 1, entities: [{ entity: "sensor.ups_load", state: "23.5", unit: "%" }] });
  });

  it("pihole_summary: authenticates, reads stats, and ends the session", async () => {
    const { send, seen } = device({
      "POST /api/auth": (r: RenderedRequest) => (JSON.parse(r.body!).password === "app-pw" ? { session: { valid: true, sid: "S1" } } : { session: { valid: false } }),
      "GET /api/stats/summary": { queries: { total: 50000, blocked: 6000, percent_blocked: 12.04 }, clients: { active: 19 }, gravity: { domains_being_blocked: 150000 } },
      "GET /api/stats/top_clients?count=10": { clients: [{ ip: "10.0.0.15", name: "tv.lan", count: 9000 }] },
      "DELETE /api/auth": {},
    });
    const res = await run("pihole_summary", { target: "10.0.0.14", password: "app-pw" }, send);
    expect(res).toEqual({ queries: 50000, blocked: 6000, blockedPercent: 12, activeClients: 19, domainsOnBlocklists: 150000, topClients: [{ ip: "10.0.0.15", name: "tv.lan", queries: 9000 }] });
    expect(seen.filter((r) => r.path.startsWith("/api/stats")).every((r) => r.headers["X-FTL-SID"] === "S1")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/auth" });
    await expect(run("pihole_summary", { target: "10.0.0.14", password: "nope" }, send)).rejects.toThrow(/refused the password/);
  });

  it("adguard_stats: basic auth, block rate and top clients; rejected credentials are explained", async () => {
    const { send, seen } = device({
      "GET /control/stats": { num_dns_queries: 2000, num_blocked_filtering: 500, avg_processing_time: 0.0123, top_clients: [{ "10.0.0.7": 800 }, { "10.0.0.15": 300 }], top_blocked_domains: [{ "ads.example": 90 }] },
      "GET /control/status": { version: "v0.107.55", protection_enabled: true },
    });
    const res = await run("adguard_stats", { target: "10.0.0.2", user: "admin", password: "pw" }, send);
    expect(seen[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
    expect(res).toEqual({
      version: "v0.107.55",
      protectionEnabled: true,
      queries: 2000,
      blocked: 500,
      blockedPercent: 25,
      avgProcessingMs: 12.3,
      topClients: [
        { name: "10.0.0.7", count: 800 },
        { name: "10.0.0.15", count: 300 },
      ],
      topBlockedDomains: [{ name: "ads.example", count: 90 }],
    });
    await expect(run("adguard_stats", { target: "10.0.0.2", user: "admin", password: "pw" }, device({}, 401).send)).rejects.toThrow(/AdGuard Home rejected the credentials/);
  });
});
