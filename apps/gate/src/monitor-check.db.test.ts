// Monitor checks through the gate, against Postgres with a fake toolbox.
import { bootstrapOrg, createMonitor, generateMasterKey } from "@moss/core";
import { auditLog, monitors, networks, type Database } from "@moss/db";
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

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_monitors"));
    orgId = (await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" })).org.id;
    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.66.0/24", status: "off_limits", source: "user" },
    ]);
    gate = createGate({ db, masterKey: generateMasterKey(), toolbox });
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

    const unknown = await monitor({ name: "Internet", kind: "tcp", target: "8.8.8.8", config: { port: 53 } });
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
});
