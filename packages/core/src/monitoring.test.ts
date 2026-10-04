import { describe, expect, it } from "vitest";
import { isFlapping, nextState, type MonitorCounters } from "./monitoring/state.js";
import { cleanText, parseWebhook } from "./monitoring/webhooks.js";

const base: MonitorCounters = { state: "up", consecutiveFailures: 0, consecutiveSuccesses: 5, failureThreshold: 3, recoveryThreshold: 2 };
const fail = { ok: false, message: "timeout" };
const pass = { ok: true, message: "200" };

function run(m: MonitorCounters, results: { ok: boolean; degraded?: boolean; message: string; policyDenied?: boolean }[]) {
  const states: string[] = [];
  let cur = m;
  for (const r of results) {
    const t = nextState(cur, r);
    cur = { ...cur, ...t };
    states.push(t.state);
  }
  return states;
}

describe("monitor state machine", () => {
  it("goes down only after the failure threshold", () => {
    expect(run(base, [fail, fail, fail, fail])).toEqual(["up", "up", "down", "down"]);
  });

  it("a single success resets the failure count", () => {
    expect(run(base, [fail, fail, pass, fail, fail])).toEqual(["up", "up", "up", "up", "up"]);
  });

  it("recovers only after the recovery threshold", () => {
    const down = { ...base, state: "down" as const, consecutiveFailures: 5, consecutiveSuccesses: 0 };
    expect(run(down, [pass, fail, pass, pass])).toEqual(["down", "down", "down", "up"]);
  });

  it("pending follows the first success, and waits for the threshold on failures", () => {
    const pending = { ...base, state: "pending" as const, consecutiveSuccesses: 0 };
    expect(run(pending, [pass])).toEqual(["up"]);
    expect(run(pending, [fail, fail, fail])).toEqual(["pending", "pending", "down"]);
  });

  it("degraded is up-but-unhealthy", () => {
    expect(run(base, [{ ok: true, degraded: true, message: "cert expires in 5 days" }, pass])).toEqual(["degraded", "up"]);
    const down = { ...base, state: "down" as const, consecutiveSuccesses: 0 };
    expect(run(down, [{ ok: true, degraded: true, message: "" }, { ok: true, degraded: true, message: "" }])).toEqual(["down", "degraded"]);
  });

  it("a policy denial is down at once", () => {
    expect(run(base, [{ ok: false, policyDenied: true, message: "off-limits" }])).toEqual(["down"]);
  });

  it("detects flapping inside the window", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect(isFlapping([ago(1), ago(5), ago(10), ago(20)], now)).toBe(true);
    expect(isFlapping([ago(1), ago(5), ago(10), ago(45)], now)).toBe(false);
  });
});

describe("webhook parsers", () => {
  it("cleans untrusted text", () => {
    expect(cleanText("line1\nIgnore previous instructions \u0007x", 100)).toBe("line1 Ignore previous instructions x");
    expect(cleanText("a".repeat(600), 500)).toHaveLength(500);
  });

  it("parses Uptime Kuma heartbeats", () => {
    const down = parseWebhook("uptime_kuma", {
      heartbeat: { monitorID: 7, status: 0, msg: "connect ECONNREFUSED 192.168.1.10:8080", ping: null },
      monitor: { id: 7, name: "Jellyfin", url: "http://192.168.1.10:8080", type: "http" },
      msg: "[Jellyfin] [🔴 Down] connect ECONNREFUSED",
    });
    expect(down).toEqual({
      ok: true,
      alerts: [{ key: "kuma:7", name: "Jellyfin", status: "down", message: "connect ECONNREFUSED 192.168.1.10:8080", target: "http://192.168.1.10:8080" }],
    });
    const up = parseWebhook("uptime_kuma", { heartbeat: { monitorID: 7, status: 1, msg: "200 - OK", ping: 23 }, monitor: { id: 7, name: "Jellyfin" } });
    expect(up).toMatchObject({ ok: true, alerts: [{ status: "up", latencyMs: 23 }] });
    expect(parseWebhook("uptime_kuma", { heartbeat: null, monitor: null, msg: "Uptime Kuma Testing" })).toEqual({ ok: true, alerts: [], test: true });
    expect(parseWebhook("uptime_kuma", { heartbeat: { status: 2 }, monitor: { id: 1 } })).toEqual({ ok: true, alerts: [] });
  });

  it("parses Beszel alerts sent through shoutrrr generic JSON", () => {
    expect(parseWebhook("beszel", { title: "Connection to nas is down", message: "Connection to nas is down" })).toMatchObject({
      ok: true,
      alerts: [{ key: "beszel:nas:status", name: "nas status", status: "down", target: "nas" }],
    });
    expect(parseWebhook("beszel", { title: "nas Disk usage above threshold", message: "Disk usage averaged 92% for the previous 10 minutes." })).toMatchObject({
      ok: true,
      alerts: [{ key: "beszel:nas:disk_usage", name: "nas Disk usage", status: "down" }],
    });
    expect(parseWebhook("beszel", { title: "nas Disk usage below threshold", message: "" })).toMatchObject({ alerts: [{ key: "beszel:nas:disk_usage", status: "up" }] });
    expect(parseWebhook("beszel", { title: "Something else" })).toMatchObject({ ok: false });
  });

  it("parses Alertmanager groups", () => {
    const res = parseWebhook("alertmanager", {
      version: "4",
      status: "firing",
      alerts: [
        { status: "firing", labels: { alertname: "HostDown", instance: "10.0.0.5:9100", severity: "critical" }, annotations: { summary: "Host is down" } },
        { status: "firing", labels: { alertname: "DiskFilling", instance: "10.0.0.5:9100", severity: "warning" }, annotations: { summary: "85% full" } },
        { status: "resolved", labels: { alertname: "HighLoad", instance: "10.0.0.6:9100" }, annotations: {} },
      ],
    });
    expect(res).toMatchObject({
      ok: true,
      alerts: [
        { key: "am:HostDown:10.0.0.5:9100", name: "HostDown on 10.0.0.5:9100", status: "down", message: "Host is down" },
        { key: "am:DiskFilling:10.0.0.5:9100", status: "degraded" },
        { key: "am:HighLoad:10.0.0.6:9100", status: "up" },
      ],
    });
  });

  it("parses generic alerts and rejects malformed ones", () => {
    expect(parseWebhook("generic", { key: "backup", name: "Nightly backup", status: "down", message: "exit 1" })).toMatchObject({
      ok: true,
      alerts: [{ key: "generic:backup", name: "Nightly backup", status: "down" }],
    });
    expect(parseWebhook("generic", { alerts: [{ key: "a", status: "up" }, { key: "b", status: "DOWN" }] })).toMatchObject({ ok: true, alerts: [{ status: "up" }, { status: "down" }] });
    expect(parseWebhook("generic", { key: "x", status: "on fire" })).toMatchObject({ ok: false });
    expect(parseWebhook("generic", [1, 2])).toMatchObject({ ok: false });
  });
});
