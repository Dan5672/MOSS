import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { parseHomeAssistantLog } from "./home-assistant.js";
import { runTool } from "./runners.js";

type Answer = { status?: number; body: string } | unknown;

/** A fake Home Assistant: answers by "METHOD path" and records every request. */
function ha(routes: Record<string, Answer | ((r: RenderedRequest) => Answer)>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    const answer = typeof route === "function" ? (route as (r: RenderedRequest) => Answer)(r) : route;
    if (answer && typeof answer === "object" && "body" in answer && typeof (answer as { body: unknown }).body === "string") {
      const a = answer as { status?: number; body: string };
      return { status: a.status ?? 200, body: Buffer.from(a.body), truncated: false };
    }
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(answer)), truncated: false };
  };
  return { send, seen };
}

const run = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);
const conn = { target: "10.0.0.20", token: "ha-token" };

describe("Home Assistant", () => {
  it("homeassistant_health: version, failed integrations, pending updates and unavailable entities", async () => {
    const { send, seen } = ha({
      "GET /api/config": { version: "2026.9.2", location_name: "Home" },
      "GET /api/states": [
        { entity_id: "sensor.ups_battery", state: "100", attributes: { friendly_name: "UPS battery" } },
        { entity_id: "light.porch", state: "unavailable", attributes: { friendly_name: "Porch light" } },
        { entity_id: "update.home_assistant_core_update", state: "on", attributes: { title: "Home Assistant Core", installed_version: "2026.9.2", latest_version: "2026.10.0" } },
        { entity_id: "update.zigbee2mqtt", state: "off", attributes: {} },
      ],
      "GET /api/config/config_entries/entry": [
        { domain: "hue", title: "Hue bridge", state: "loaded" },
        { domain: "unifi", title: "UniFi", state: "setup_retry", reason: "Connection refused" },
      ],
    });
    const res = await run("homeassistant_health", conn, send);
    expect(seen[0]).toMatchObject({ target: "10.0.0.20", port: 8123, scheme: "http", headers: expect.objectContaining({ Authorization: "Bearer ha-token" }) });
    expect(res).toEqual({
      version: "2026.9.2",
      locationName: "Home",
      entities: 4,
      unavailable: { count: 1, entities: [{ entity: "light.porch", name: "Porch light" }] },
      updates: [{ entity: "update.home_assistant_core_update", name: "Home Assistant Core", installed: "2026.9.2", latest: "2026.10.0" }],
      integrations: { total: 2, failed: [{ domain: "unifi", title: "UniFi", state: "setup_retry", reason: "Connection refused" }] },
    });
  });

  it("homeassistant_health: the integration list is optional (non-admin token)", async () => {
    const { send } = ha({ "GET /api/config": { version: "2026.9.2" }, "GET /api/states": [] });
    expect(await run("homeassistant_health", conn, send)).toMatchObject({ integrations: null, entities: 0 });
  });

  it("homeassistant_health: a rejected token is a clear error", async () => {
    const { send } = ha({ "GET /api/config": { status: 401, body: "" }, "GET /api/states": { status: 401, body: "" } });
    await expect(run("homeassistant_health", conn, send)).rejects.toThrow(/rejected the credentials/);
  });

  it("homeassistant_logs: groups repeats, counts levels, keeps the exception line of a traceback", async () => {
    const log = [
      "2026-10-06 07:00:00.001 WARNING (MainThread) [homeassistant.components.zha] Device 0x1a2b did not respond",
      "2026-10-06 07:10:00.001 WARNING (MainThread) [homeassistant.components.zha] Device 0x3c4d did not respond",
      "2026-10-06 07:20:00.001 ERROR (MainThread) [homeassistant.components.unifi] Error connecting to 10.0.0.1",
      "Traceback (most recent call last):",
      '  File "x.py", line 1, in <module>',
      "aiohttp.ClientConnectorError: Cannot connect to host 10.0.0.1:443",
      "2026-10-06 07:30:00.001 INFO (MainThread) [homeassistant.core] Started",
    ].join("\n");
    const { send, seen } = ha({ "GET /api/error_log": { status: 206, body: `partial first line\n${log}` } });
    const res = (await run("homeassistant_logs", conn, send)) as Record<string, unknown>;
    expect(seen[0]!.headers.Range).toMatch(/^bytes=-\d+$/);
    expect(res.partial).toBe(true);
    expect(res.counts).toEqual({ WARNING: 2, ERROR: 1 });
    expect(res.groups).toEqual([
      {
        level: "ERROR",
        logger: "homeassistant.components.unifi",
        count: 1,
        firstSeen: "2026-10-06T07:20:00",
        lastSeen: "2026-10-06T07:20:00",
        message: "Error connecting to 10.0.0.1 | aiohttp.ClientConnectorError: Cannot connect to host 10.0.0.1:443",
      },
      { level: "WARNING", logger: "homeassistant.components.zha", count: 2, firstSeen: "2026-10-06T07:00:00", lastSeen: "2026-10-06T07:10:00", message: "Device 0x1a2b did not respond" },
    ]);
    expect(res.latest).toHaveLength(1);
  });

  it("parseHomeAssistantLog: 'the last N hours' counts back from the newest entry", () => {
    const text = ["2026-10-01 07:00:00.0 ERROR (MainThread) [a] old", "2026-10-06 07:00:00.0 ERROR (MainThread) [a] new"].join("\n");
    const res = parseHomeAssistantLog(text, { sinceHours: 24, minLevel: "WARNING", partial: false });
    expect(res.groups.map((g) => g.message)).toEqual(["new"]);
  });

  it("homeassistant_devices: renders the device template and keeps only valid MACs and IPv4 addresses", async () => {
    const { send, seen } = ha({
      "POST /api/template": {
        body: JSON.stringify([
          { id: "d1", name: "Living room TV", manufacturer: "LG", model: "OLED55", area: "Living room", connections: [["mac", "AA-BB-CC-DD-EE-FF"], ["zigbee", "0x00"]], ips: ["10.0.0.50", "fe80::1", "junk"] },
          { id: "d2", name: "Sun", connections: [], ips: [] },
          { name: "no id" },
        ]),
      },
    });
    const res = await run("homeassistant_devices", conn, send);
    expect(JSON.parse(seen[0]!.body!).template).toContain("device_attr");
    expect(res).toEqual({
      total: 2,
      devices: [
        { id: "d1", name: "Living room TV", manufacturer: "LG", model: "OLED55", area: "Living room", macs: ["aa:bb:cc:dd:ee:ff"], ips: ["10.0.0.50"] },
        { id: "d2", name: "Sun", manufacturer: undefined, model: undefined, area: undefined, macs: [], ips: [] },
      ],
    });
  });

  it("homeassistant_notify: calls the notify service with a link", async () => {
    const { send, seen } = ha({ "POST /api/services/notify/mobile_app_pixel": [] });
    const res = await run("homeassistant_notify", { ...conn, service: "mobile_app_pixel", title: "INC-4 opened", message: "NAS is down", url: "http://10.0.0.5:3080/incidents/x" }, send);
    expect(res).toEqual({ service: "mobile_app_pixel", sent: true });
    expect(JSON.parse(seen[0]!.body!)).toEqual({ title: "INC-4 opened", message: "NAS is down", data: { url: "http://10.0.0.5:3080/incidents/x", clickAction: "http://10.0.0.5:3080/incidents/x" } });
    await expect(run("homeassistant_notify", { ...conn, service: "../states", title: "t", message: "m" }, send)).rejects.toThrow(/Invalid arguments/);
  });

  it("homeassistant_publish: only MOSS's own entities can be written", async () => {
    const { send, seen } = ha({ "POST /api/states/sensor.moss_open_incidents": {} });
    await run("homeassistant_publish", { ...conn, states: [{ entity: "sensor.moss_open_incidents", state: "2", attributes: { unit_of_measurement: "incidents" } }] }, send);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ state: "2", attributes: { unit_of_measurement: "incidents" } });
    await expect(run("homeassistant_publish", { ...conn, states: [{ entity: "switch.modem", state: "off" }] }, send)).rejects.toThrow(/Invalid arguments/);
  });
});
