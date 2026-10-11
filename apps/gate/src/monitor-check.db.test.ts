// Monitor checks through the gate, against Postgres with a fake toolbox.
import { bootstrapOrg, createMonitor, encryptSecret, generateMasterKey } from "@moss/core";
import { auditLog, monitors, networks, secrets, type Database } from "@moss/db";
import { randomUUID } from "node:crypto";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateServer } from "./server.js";
import { createGate, type Gate } from "./service.js";
import type { ToolboxClient } from "./toolbox-client.js";

describe.skipIf(!TEST_DATABASE_URL)("monitor checks (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let gate: Gate;
  let orgId: string;
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let dns: Record<string, string[]> = {};
  let reply: (tool: string, args: Record<string, unknown>) => unknown = () => ({});
  const owner = { type: "system" as const, id: null };

  const toolbox: ToolboxClient = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "dns_lookup") return { ok: true, result: { name: args.name, type: args.type, answers: args.type === "A" ? (dns[args.name as string] ?? []) : [] } };
      return { ok: true, result: reply(tool, args) };
    },
  };

  const monitor = (input: Parameters<typeof createMonitor>[2]) => createMonitor(db, orgId, input, owner);
  let person: { type: "user"; id: string };
  const masterKey = generateMasterKey();
  let clock = new Date("2030-01-01T00:00:00Z");

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_monitors"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    person = { type: "user", id: boot.owner.id };
    const secret = async (name: string, value: string, scope: { allowedHosts?: string[]; allowedTools?: string[] } = {}) => {
      const id = randomUUID();
      await db.insert(secrets).values({ id, orgId, name, type: "password", ...scope, ...encryptSecret(masterKey, id, value) });
    };
    await secret("router-snmp", "c0mmunity");
    await secret("nas-ssh", "-----BEGIN KEY-----", { allowedHosts: ["192.168.1.10/32"] });
    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.66.0/24", status: "off_limits", source: "user" },
    ]);
    gate = createGate({ db, masterKey, toolbox, now: () => clock });
  });
  afterAll(async () => close?.());
  beforeEach(async () => {
    calls.length = 0;
    dns = {};
    await db.delete(monitors);
  });

  it("probes allowed IPs with arguments built from the monitor", async () => {
    reply = () => ({ url: "x", ok: true, status: 200, latencyMs: 31, keywordFound: true });
    const m = await monitor({ name: "NAS", kind: "http", target: "192.168.1.10", config: { port: 5000, keyword: "Synology" }, timeoutSeconds: 5 });
    expect(await gate.checkMonitor(m.id)).toEqual({ ok: true, latencyMs: 31, message: "HTTP 200, 31 ms" });
    expect(calls).toEqual([
      { tool: "http_probe", args: { target: "192.168.1.10", port: 5000, scheme: "http", path: "/", method: "GET", keyword: "Synology", verifyTls: true, timeoutMs: 5000 } },
    ]);
  });

  it("resolves hostnames, then probes the IP with the name as Host/SNI", async () => {
    dns = { "nas.home.lan": ["192.168.1.10"] };
    reply = () => ({ target: "192.168.1.10", port: 443, altNames: [], trusted: true, daysRemaining: 9, subject: "nas", latencyMs: 4 });
    const m = await monitor({ name: "NAS cert", kind: "tls", target: "nas.home.lan" });
    expect(await gate.checkMonitor(m.id)).toMatchObject({ ok: true, degraded: true, message: "Certificate for nas expires in 9 days" });
    expect(calls[1]).toEqual({ tool: "tls_inspect", args: { target: "192.168.1.10", port: 443, servername: "nas.home.lan", timeoutMs: 10_000 } });
  });

  it("refuses targets outside allowed networks, including hostnames that resolve into them, and audits once", async () => {
    dns = { "printer.lan": ["192.168.66.5"] };
    const byName = await monitor({ name: "Printer", kind: "ping", target: "printer.lan" });
    const res = await gate.checkMonitor(byName.id);
    expect(res).toMatchObject({ ok: false, policyDenied: true, message: expect.stringMatching(/off-limits network 192\.168\.66\.0\/24/) });
    expect(calls.map((c) => c.tool)).toEqual(["dns_lookup"]); // never probed

    // A private address outside the allowed networks is refused (a public one would be allowed).
    const unknown = await monitor({ name: "Lab box", kind: "tcp", target: "172.16.5.5", config: { port: 22 } });
    expect(await gate.checkMonitor(unknown.id)).toMatchObject({ ok: false, policyDenied: true, message: expect.stringMatching(/not inside an allowed network/) });

    const denials = () => db.select().from(auditLog).where(and(eq(auditLog.action, "monitor.check_denied"), eq(auditLog.targetId, unknown.id)));
    expect(await denials()).toHaveLength(1);
    await db.update(monitors).set({ lastResult: { ok: false, message: "x", at: new Date().toISOString(), policyDenied: true } }).where(eq(monitors.id, unknown.id));
    await gate.checkMonitor(unknown.id);
    expect(await denials()).toHaveLength(1);
  });

  it("reports unresolvable names and failed connections as down", async () => {
    const m = await monitor({ name: "Ghost", kind: "ping", target: "ghost.lan" });
    expect(await gate.checkMonitor(m.id)).toEqual({ ok: false, message: "Could not resolve ghost.lan" });
    reply = () => ({ target: "192.168.1.20", port: 22, open: false, latencyMs: 3, error: "ECONNREFUSED: connect ECONNREFUSED" });
    const ssh = await monitor({ name: "SSH", kind: "tcp", target: "192.168.1.20", config: { port: 22 } });
    expect(await gate.checkMonitor(ssh.id)).toMatchObject({ ok: false, message: "Port 22: ECONNREFUSED: connect ECONNREFUSED" });
  });

  it("flags slow responses as degraded and checks DNS answers", async () => {
    reply = () => ({ target: "192.168.1.1", transmitted: 3, received: 3, lossPercent: 0, rttAvgMs: 450 });
    const slow = await monitor({ name: "Router", kind: "ping", target: "192.168.1.1", config: { degradedMs: 200 } });
    expect(await gate.checkMonitor(slow.id)).toMatchObject({ ok: true, degraded: true, latencyMs: 450 });

    dns = { "nas.home.lan": ["192.168.1.11"] };
    const d = await monitor({ name: "DNS", kind: "dns", target: "nas.home.lan", config: { expectAnswer: "192.168.1.10" } });
    expect(await gate.checkMonitor(d.id)).toMatchObject({ ok: false, message: "nas.home.lan A: 192.168.1.11 (expected 192.168.1.10)" });
  });

  it("exposes checks over HTTP to the worker token only", async () => {
    reply = () => ({ target: "192.168.1.1", transmitted: 3, received: 3, lossPercent: 0, rttAvgMs: 2 });
    const m = await monitor({ name: "Router", kind: "ping", target: "192.168.1.1" });
    const token = "g".repeat(40);
    const app = buildGateServer(gate, { token, secrets: { token: "w".repeat(40), write: async () => ({ id: "x", created: true }) } });
    const post = (auth: string, body: unknown) => app.inject({ method: "POST", url: "/v1/monitor-checks", headers: { authorization: `Bearer ${auth}` }, payload: body as object });
    expect((await post("w".repeat(40), { monitorId: m.id })).statusCode).toBe(401);
    expect((await post(token, { monitorId: "nope" })).statusCode).toBe(400);
    const ok = await post(token, { monitorId: m.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, message: "3/3 replies, 2 ms" });
    await app.close();
  });

  describe("metric monitors", () => {
    it("works out an interface's traffic from two checks, and never shows the community", async () => {
      let octets = 1_000_000;
      reply = (tool, args) => {
        expect(args.community).toBe("c0mmunity"); // decrypted for the toolbox only
        const oids = args.oids as string[];
        const v: Record<string, string> = {};
        for (const o of oids) {
          if (o.startsWith("1.3.6.1.2.1.31.1.1.1.6.")) v[o] = String(octets);
          else if (o.startsWith("1.3.6.1.2.1.31.1.1.1.10.")) v[o] = String(octets / 2);
          else if (o.startsWith("1.3.6.1.2.1.2.2.1.8.")) v[o] = "1";
          else if (o.startsWith("1.3.6.1.2.1.31.1.1.1.1.")) v[o] = "eth3";
          else v[o] = "0";
        }
        return { target: args.target, preset: "get", values: v };
      };
      const m = await createMonitor(db, orgId, { name: "Uplink", kind: "snmp", target: "192.168.1.1", config: { secret: "router-snmp", ifIndex: 3, metric: "inBps", warnAbove: 1_000_000 } }, person);
      clock = new Date("2030-01-01T00:00:00Z");
      const first = await gate.checkMonitor(m.id);
      expect(first).toMatchObject({ ok: true, value: null, message: "eth3 up, measuring traffic (needs two checks)", counters: { inOctets: 1_000_000 } });
      await db.update(monitors).set({ lastResult: { ...first!, at: clock.toISOString() } as never }).where(eq(monitors.id, m.id));
      octets += 15_000_000; // 15 MB in a minute: 2 Mbps in
      clock = new Date("2030-01-01T00:01:00Z");
      const second = await gate.checkMonitor(m.id);
      expect(second).toMatchObject({ ok: true, degraded: true, values: { inBps: 2_000_000, outBps: 1_000_000 }, message: "inBps 2000000 is above 1000000" });
      expect(JSON.stringify(second)).not.toContain("c0mmunity");
    });

    it("needs secrets.manage to use a secret, and the secret's own host scope", async () => {
      await expect(monitor({ name: "x", kind: "snmp", target: "192.168.1.1", config: { secret: "router-snmp", oid: "1.3.6.1.2.1.1.3.0" } })).rejects.toThrow(/secrets.manage/);
      await expect(createMonitor(db, orgId, { name: "x", kind: "snmp", target: "192.168.1.1", config: { secret: "nope", oid: "1.3.6.1.2.1.1.3.0" } }, person)).rejects.toThrow(/no stored secret/);
      // nas-ssh may only be used against 192.168.1.10.
      const m = await createMonitor(db, orgId, { name: "Pi", kind: "host", target: "192.168.1.20", config: { secret: "nas-ssh", user: "moss" } }, person);
      expect(await gate.checkMonitor(m.id)).toMatchObject({ ok: false, policyDenied: true, message: expect.stringMatching(/nas-ssh may not be used against 192\.168\.1\.20/) });
      expect(calls).toEqual([]);
    });

    it("reads host load, memory and the fullest disk", async () => {
      reply = (tool) =>
        tool === "host_facts"
          ? { cpus: 4, memoryGb: { total: 8, available: 2 }, load: { "1m": 0.5, "5m": 0.4, "15m": 0.3 } }
          : { fullest: { mount: "/srv", usedPercent: 91 } };
      const m = await createMonitor(db, orgId, { name: "NAS", kind: "host", target: "192.168.1.10", config: { secret: "nas-ssh", user: "moss", metric: "diskUsedPercent", critAbove: 90 } }, person);
      expect(await gate.checkMonitor(m.id)).toMatchObject({
        ok: false,
        values: { load1: 0.5, cpus: 4, memUsedPercent: 75, diskUsedPercent: 91 },
        message: "diskUsedPercent 91 is above 90",
      });
      expect(calls.map((c) => [c.tool, c.args.user, c.args.key])).toEqual([
        ["host_facts", "moss", "-----BEGIN KEY-----"],
        ["disk_usage", "moss", "-----BEGIN KEY-----"],
      ]);
    });
  });
});
