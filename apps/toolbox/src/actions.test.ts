import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import { homeassistantPowerCycle } from "./actions.js";
import type { RawRequest } from "./custom-http.js";
import { runTool } from "./runners.js";
import type { SshRun } from "./servers.js";

const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
const ssh = { target: "10.0.0.5", user: "moss", key: KEY };

function fakeSsh(reply: (cmd: string) => { stdout?: string; stderr?: string; code?: number }) {
  const commands: string[] = [];
  const run: SshRun = async (_t, cmd) => {
    commands.push(cmd);
    const r = reply(cmd);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0, hostKeySha256: "SHA256:x" };
  };
  return { run, commands };
}

const sshTool = (tool: string, args: Record<string, unknown>, run: SshRun) => runTool(tool, { ...ssh, ...args }, undefined, undefined, undefined, undefined, run);

function device(routes: Record<string, unknown | ((r: RenderedRequest) => unknown)>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from(""), truncated: false };
    const json = typeof route === "function" ? (route as (r: RenderedRequest) => unknown)(r) : route;
    return { status: json === null ? 204 : 200, body: Buffer.from(json === null ? "" : JSON.stringify(json)), truncated: false };
  };
  return { send, seen };
}
const httpTool = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);

describe("server write tools", () => {
  it("service_restart runs sudo -n systemctl with a quoted unit and reports the new state", async () => {
    const { run, commands } = fakeSsh(() => ({ stdout: "ActiveState=active\nSubState=running\nActiveEnterTimestamp=Tue 2026-10-06 10:00:00 AEST\n" }));
    const res = await sshTool("service_restart", { service: "nginx", action: "restart" }, run);
    expect(commands).toEqual([
      "sudo -n systemctl restart 'nginx'; rc=$?; systemctl show 'nginx' --property=ActiveState,SubState,Result,ActiveEnterTimestamp --no-pager; exit $rc",
    ]);
    expect(res).toMatchObject({ service: "nginx", action: "restart", active: "active", sub: "running" });
  });

  it("explains a missing sudo rule instead of failing obscurely", async () => {
    const { run } = fakeSsh(() => ({ code: 1, stderr: "sudo: a password is required" }));
    await expect(sshTool("service_restart", { service: "nginx" }, run)).rejects.toThrow(/passwordless sudo for systemctl/);
    await expect(sshTool("host_reboot", {}, run)).rejects.toThrow(/passwordless sudo for shutdown/);
  });

  it("container_restart and host_reboot send fixed commands", async () => {
    const { run, commands } = fakeSsh((cmd) => (cmd.startsWith("docker") ? { stdout: '{"Status":"running","Running":true,"StartedAt":"2026-10-06T00:00:00Z"}' } : {}));
    expect(await sshTool("container_restart", { container: "plex" }, run)).toMatchObject({ container: "plex", running: true, status: "running" });
    expect(await sshTool("host_reboot", { delayMinutes: 2 }, run)).toMatchObject({ scheduled: true, inMinutes: 2 });
    expect(commands).toEqual([
      "docker restart 'plex' >/dev/null && docker inspect --format '{{json .State}}' 'plex'",
      "sudo -n shutdown -r +2 'Reboot by an approved MOSS change'",
    ]);
    await expect(sshTool("container_restart", { container: "plex; rm -rf /" }, run)).rejects.toThrow(/Invalid arguments/);
  });
});

describe("home automation and DNS write tools", () => {
  it("homeassistant_power_cycle turns off, waits, turns on, and reports each state", async () => {
    let state = "on";
    const calls: string[] = [];
    const { send } = device({
      "GET /api/states/switch.modem_plug": () => ({ state }),
      "POST /api/services/switch/turn_off": () => ((state = "off"), calls.push("off"), []),
      "POST /api/services/switch/turn_on": () => ((state = "on"), calls.push("on"), []),
    });
    const waits: number[] = [];
    const res = await homeassistantPowerCycle(
      { target: "10.0.0.13", port: 8123, scheme: "http", verifyTls: false, timeoutMs: 5000, token: "t", entity: "switch.modem_plug", offSeconds: 20 },
      send,
      async (ms) => void waits.push(ms),
    );
    expect(calls).toEqual(["off", "on"]);
    expect(waits[0]).toBe(20_000);
    expect(res).toMatchObject({ before: "on", whileOff: "off", after: "on", ok: true });
  });

  it("homeassistant_switch only accepts controllable entities", async () => {
    const { send } = device({});
    await expect(httpTool("homeassistant_switch", { target: "10.0.0.13", token: "t", entity: "lock.front_door", action: "turn_off" }, send)).rejects.toThrow(/Invalid arguments/);
  });

  it("pihole_domain_rule adds to the deny list, and removing something already gone is not an error", async () => {
    let listed = false;
    const { send, seen } = device({
      "POST /api/auth": { session: { valid: true, sid: "S" } },
      "POST /api/domains/deny/exact": () => ((listed = true), { domains: [{ domain: "ads.example.com" }] }),
      "GET /api/domains/deny/exact/ads.example.com": () => ({ domains: listed ? [{ domain: "ads.example.com" }] : [] }),
      "DELETE /api/auth": null,
    });
    expect(await httpTool("pihole_domain_rule", { target: "10.0.0.14", password: "p", domain: "ads.example.com", list: "deny", action: "add" }, send)).toEqual({
      domain: "ads.example.com",
      list: "deny",
      action: "add",
      onList: true,
    });
    expect(JSON.parse(seen.find((r) => r.method === "POST" && r.path === "/api/domains/deny/exact")!.body!)).toMatchObject({ domain: "ads.example.com" });
    listed = false;
    expect(await httpTool("pihole_domain_rule", { target: "10.0.0.14", password: "p", domain: "ads.example.com", list: "deny", action: "remove" }, send)).toMatchObject({ onList: false });
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: "/api/auth" });
  });

  it("pihole_local_dns adds a host record", async () => {
    const { send, seen } = device({
      "POST /api/auth": { session: { valid: true, sid: "S" } },
      "PUT /api/config/dns/hosts/10.0.0.12%20nas.lan": null,
      "GET /api/config/dns/hosts": { config: { dns: { hosts: ["10.0.0.12 nas.lan"] } } },
      "DELETE /api/auth": null,
    });
    expect(await httpTool("pihole_local_dns", { target: "10.0.0.14", password: "p", hostname: "nas.lan", ip: "10.0.0.12", action: "add" }, send)).toEqual({ hostname: "nas.lan", ip: "10.0.0.12", action: "add", present: true });
    expect(seen.some((r) => r.method === "PUT")).toBe(true);
  });

  it("adguard_rule changes only its own rules for the domain", async () => {
    let rules = ["||tracker.example^", "@@||ads.example.com^", "! comment"];
    const { send } = device({
      "GET /control/filtering/status": () => ({ user_rules: rules }),
      "POST /control/filtering/set_rules": (r: RenderedRequest) => ((rules = JSON.parse(r.body!).rules), null),
    });
    await httpTool("adguard_rule", { target: "10.0.0.2", user: "admin", password: "p", domain: "ads.example.com", action: "block" }, send);
    expect(rules).toEqual(["||tracker.example^", "! comment", "||ads.example.com^"]);
    await httpTool("adguard_rule", { target: "10.0.0.2", user: "admin", password: "p", domain: "ads.example.com", action: "remove" }, send);
    expect(rules).toEqual(["||tracker.example^", "! comment"]);
  });

  it("adguard_rewrite adds a rewrite and confirms it", async () => {
    const { send } = device({ "POST /control/rewrite/add": null, "GET /control/rewrite/list": [{ domain: "nas.lan", answer: "10.0.0.12" }] });
    expect(await httpTool("adguard_rewrite", { target: "10.0.0.2", user: "admin", password: "p", domain: "nas.lan", answer: "10.0.0.12", action: "add" }, send)).toMatchObject({ present: true });
  });
});

describe("UniFi write tools", () => {
  const base = { controller: "10.0.0.138", apiKey: "k" };
  const ok = (data: unknown[]) => ({ meta: { rc: "ok" }, data });

  it("unifi_client_block sends the stamgr command with the API key and reads back the client", async () => {
    const { send, seen } = device({
      "POST /proxy/network/api/s/default/cmd/stamgr": ok([]),
      "GET /proxy/network/api/s/default/stat/user/aa:bb:cc:dd:ee:ff": ok([{ _id: "0123456789abcdef01234567", blocked: true, name: "old-laptop" }]),
    });
    expect(await httpTool("unifi_client_block", { ...base, mac: "AA-BB-CC-DD-EE-FF", action: "block" }, send)).toEqual({ mac: "aa:bb:cc:dd:ee:ff", action: "block", blocked: true, name: "old-laptop" });
    expect(seen[0]).toMatchObject({ headers: expect.objectContaining({ "X-API-KEY": "k" }), body: JSON.stringify({ cmd: "block-sta", mac: "aa:bb:cc:dd:ee:ff" }) });
  });

  it("unifi_dhcp_reservation sets and clears a fixed IP, and needs a known client", async () => {
    const { send, seen } = device({
      "GET /proxy/network/api/s/default/stat/user/aa:bb:cc:dd:ee:ff": ok([{ _id: "0123456789abcdef01234567" }]),
      "PUT /proxy/network/api/s/default/rest/user/0123456789abcdef01234567": (r: RenderedRequest) => ok([{ ...JSON.parse(r.body!) }]),
      "GET /proxy/network/api/s/default/stat/user/11:22:33:44:55:66": ok([]),
    });
    expect(await httpTool("unifi_dhcp_reservation", { ...base, mac: "aa:bb:cc:dd:ee:ff", ip: "10.0.0.50" }, send)).toMatchObject({ reserved: true, ip: "10.0.0.50" });
    expect(await httpTool("unifi_dhcp_reservation", { ...base, mac: "aa:bb:cc:dd:ee:ff" }, send)).toMatchObject({ reserved: false });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ use_fixedip: false });
    await expect(httpTool("unifi_dhcp_reservation", { ...base, mac: "11:22:33:44:55:66", ip: "10.0.0.51" }, send)).rejects.toThrow(/doesn't know a client/);
  });

  it("unifi_wlan_enable finds the network by SSID", async () => {
    const { send } = device({
      "GET /proxy/network/api/s/default/rest/wlanconf": ok([{ _id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Guest" }]),
      "PUT /proxy/network/api/s/default/rest/wlanconf/aaaaaaaaaaaaaaaaaaaaaaaa": ok([{ enabled: false }]),
    });
    expect(await httpTool("unifi_wlan_enable", { ...base, ssid: "Guest", enabled: false }, send)).toEqual({ ssid: "Guest", enabled: false });
    await expect(httpTool("unifi_wlan_enable", { ...base, ssid: "Office", enabled: true }, send)).rejects.toThrow(/No Wi-Fi network called "Office" \(networks: Guest\)/);
  });
});
