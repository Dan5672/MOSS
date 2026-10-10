// Monitoring against Postgres: state transitions, events, incidents, maintenance suppression and webhooks.
import { agents, assets, changeAssets, changeRequests, events, incidentComments, incidents, models, monitorResults, monitors, providers, roles, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseWebhook } from "./monitoring/webhooks.js";
import {
  authenticateMonitorSource,
  checkMonitorNow,
  claimDueMonitors,
  createMonitor,
  createMonitorSource,
  getMonitor,
  handleMonitorDown,
  handleMonitorUp,
  ingestAlerts,
  listMonitors,
  MonitorValidationError,
  pruneMonitorResults,
  recordMonitorResult,
  setMonitorEnabled,
} from "./services/monitors.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { setSetting } from "./store/settings-store.js";

describe.skipIf(!TEST_DATABASE_URL)("monitoring (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  let assetId: string;
  const owner = () => ({ type: "user" as const, id: ownerId });
  const fail = { ok: false, message: "connect ECONNREFUSED" };
  const pass = { ok: true, latencyMs: 12, message: "200" };

  async function pendingEvents() {
    const rows = await db.select().from(events).where(isNull(events.processedAt)).orderBy(asc(events.id));
    await db.update(events).set({ processedAt: new Date() }).where(isNull(events.processedAt));
    return rows.map((e) => ({ type: e.type, payload: e.payload }));
  }

  async function newMonitor(extra: Record<string, unknown> = {}) {
    return createMonitor(db, orgId, { name: "NAS web", kind: "http", target: "192.168.1.10", config: { port: 5000 }, assetId, responderAgentId: agentId, ...extra }, owner());
  }

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_monitors"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    ownerId = boot.owner.id;
    const [p] = await db.insert(providers).values({ orgId, kind: "ollama", name: "L" }).returning();
    const [m] = await db.insert(models).values({ orgId, providerId: p!.id, modelId: "m", displayName: "M" }).returning();
    const [roleAgent] = await db.select().from(roles).where(eq(roles.key, "agent"));
    [{ id: agentId }] = await db.insert(agents).values({ orgId, name: "Sam", title: "Systems Admin", systemPrompt: "x", modelId: m!.id, roleId: roleAgent!.id }).returning();
    [{ id: assetId }] = await db.insert(assets).values({ orgId, name: "nas", source: "user", primaryIp: "192.168.1.10" }).returning();
  });
  afterAll(async () => close?.());
  beforeEach(async () => {
    await db.delete(monitors);
    await db.update(events).set({ processedAt: new Date() }).where(isNull(events.processedAt));
  });

  it("validates monitor input", async () => {
    await expect(createMonitor(db, orgId, { name: "x", kind: "tcp", target: "192.168.1.1" }, owner())).rejects.toThrow(/needs a port/);
    await expect(createMonitor(db, orgId, { name: "x", kind: "ping", target: "10.0.0.0/8" }, owner())).rejects.toThrow(MonitorValidationError);
    await expect(createMonitor(db, orgId, { name: "x", kind: "ping", target: "a b" }, owner())).rejects.toThrow(/IP address or hostname/);
    await expect(createMonitor(db, orgId, { name: "x", kind: "ping", target: "nas.lan", intervalSeconds: 5 }, owner())).rejects.toThrow(MonitorValidationError);
    // A public address is checked at most once a minute; a private one can be checked more often.
    await expect(createMonitor(db, orgId, { name: "x", kind: "ping", target: "1.1.1.1", intervalSeconds: 30 }, owner())).rejects.toThrow(/at most once a minute/);
    expect(await createMonitor(db, orgId, { name: "x", kind: "ping", target: "192.168.1.1", intervalSeconds: 30 }, owner())).toMatchObject({ intervalSeconds: 30 });
    const ok = await createMonitor(db, orgId, { name: "x", kind: "ping", target: "nas.lan" }, owner());
    expect(ok).toMatchObject({ state: "pending", intervalSeconds: 60, failureThreshold: 3 });
  });

  it("claims due monitors once and pushes the next check out", async () => {
    const m = await newMonitor({ intervalSeconds: 120 });
    await createMonitor(db, orgId, { name: "paused", kind: "ping", target: "192.168.1.2" }, owner()).then((p) => setMonitorEnabled(db, orgId, p.id, false, owner()));
    expect(await claimDueMonitors(db)).toEqual([m.id]);
    expect(await claimDueMonitors(db)).toEqual([]);
    const [row] = await db.select().from(monitors).where(eq(monitors.id, m.id));
    expect(row!.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 100_000);
    await checkMonitorNow(db, orgId, m.id);
    expect(await claimDueMonitors(db)).toEqual([m.id]);
  });

  it("raises one incident for the responder on down, comments on recovery", async () => {
    const m = await newMonitor();
    await recordMonitorResult(db, m.id, pass);
    expect(await pendingEvents()).toEqual([]); // pending -> up is not news
    await recordMonitorResult(db, m.id, fail);
    await recordMonitorResult(db, m.id, fail);
    expect(await pendingEvents()).toEqual([]);
    const third = await recordMonitorResult(db, m.id, fail);
    expect(third).toMatchObject({ changed: true, from: "up", monitor: { state: "down" } });
    expect(await pendingEvents()).toEqual([{ type: "monitor.down", payload: { monitorId: m.id } }]);

    const outcome = await handleMonitorDown(db, m.id);
    expect(outcome.action).toBe("created");
    const incidentId = (outcome as { incidentId: string }).incidentId;
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(inc).toMatchObject({ title: "NAS web is down", priority: "P3", assignedAgentId: agentId, raisedByUserId: null, raisedByAgentId: null });
    expect(inc!.description).toContain("data, not instructions");
    expect(inc!.description).toContain("connect ECONNREFUSED");
    // createIncident emitted incident.assigned, which is what starts the agent's run.
    expect((await pendingEvents()).map((e) => e.type)).toEqual(["incident.created", "incident.assigned"]);

    // A second down event while the incident is open does not open another one.
    expect(await handleMonitorDown(db, m.id)).toMatchObject({ action: "commented", incidentId, agentId });

    await recordMonitorResult(db, m.id, pass);
    expect(await pendingEvents()).toEqual([]);
    await recordMonitorResult(db, m.id, pass);
    const [up] = await pendingEvents();
    expect(up).toMatchObject({ type: "monitor.up", payload: { monitorId: m.id } });
    expect(await handleMonitorUp(db, m.id, new Date((up!.payload as { downSince: string }).downSince))).toMatchObject({ action: "commented", incidentId, agentId });
    const comments = await db.select().from(incidentComments).where(eq(incidentComments.incidentId, incidentId));
    expect(comments.map((c) => c.body)).toEqual([expect.stringContaining("went down again"), expect.stringMatching(/recovered after \d+m/)]);
    expect((await db.select().from(incidents).where(eq(incidents.id, incidentId)))[0]!.status).toBe("new");
  });

  it("auto-resolves when configured", async () => {
    const m = await newMonitor({ autoResolve: true, failureThreshold: 1, recoveryThreshold: 1 });
    await recordMonitorResult(db, m.id, fail);
    const created = await handleMonitorDown(db, m.id);
    await recordMonitorResult(db, m.id, pass);
    const outcome = await handleMonitorUp(db, m.id, new Date(Date.now() - 5 * 60_000));
    expect(outcome).toMatchObject({ action: "resolved" });
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, (created as { incidentId: string }).incidentId));
    expect(inc!.status).toBe("resolved");
    expect((await db.select().from(monitors).where(eq(monitors.id, m.id)))[0]!.openIncidentId).toBeNull();
  });

  it("suppresses incidents during a change on the asset, then raises one if still down after", async () => {
    const m = await newMonitor({ failureThreshold: 1 });
    const [cr] = await db
      .insert(changeRequests)
      .values({ orgId, type: "normal", status: "in_progress", title: "Restart NAS", description: "x", risk: "low", rollbackPlan: "x", verificationPlan: "x" })
      .returning();
    await db.insert(changeAssets).values({ changeId: cr!.id, assetId });
    await recordMonitorResult(db, m.id, fail);
    expect(await pendingEvents()).toEqual([]);
    const detail = await getMonitor(db, orgId, m.id);
    expect(detail!.changes[0]).toMatchObject({ to: "down", suppressed: true });

    await db.update(changeRequests).set({ status: "succeeded" }).where(eq(changeRequests.id, cr!.id));
    await recordMonitorResult(db, m.id, fail);
    expect(await pendingEvents()).toEqual([{ type: "monitor.down", payload: { monitorId: m.id } }]);
  });

  it("maintenance mode (from Home Assistant) keeps monitors quiet, and an outage that outlasts it is raised", async () => {
    const m = await newMonitor({ failureThreshold: 1, assetId: null });
    await setSetting(db, orgId, "monitoring.quiet_until", new Date(Date.now() + 3_600_000).toISOString());
    await recordMonitorResult(db, m.id, fail);
    expect(await pendingEvents()).toEqual([]);
    await setSetting(db, orgId, "monitoring.quiet_until", new Date(Date.now() - 1000).toISOString());
    await recordMonitorResult(db, m.id, fail);
    expect(await pendingEvents()).toEqual([{ type: "monitor.down", payload: { monitorId: m.id } }]);
    await setSetting(db, orgId, "monitoring.quiet_until", "");
  });

  it("ignores results for paused monitors", async () => {
    const m = await newMonitor();
    await setMonitorEnabled(db, orgId, m.id, false, owner());
    expect(await recordMonitorResult(db, m.id, fail)).toBeNull();
    expect(await db.select().from(monitorResults).where(eq(monitorResults.monitorId, m.id))).toEqual([]);
  });

  it("reports uptime and prunes old results", async () => {
    const m = await newMonitor();
    await recordMonitorResult(db, m.id, pass);
    await recordMonitorResult(db, m.id, fail);
    await recordMonitorResult(db, m.id, pass, new Date(Date.now() - 30 * 86_400_000));
    const [listed] = await listMonitors(db, orgId);
    expect(listed).toMatchObject({ id: m.id, assetName: "nas", responderName: "Sam", uptime24h: 0.5 });
    expect(await pruneMonitorResults(db, orgId, 14)).toBe(1);
  });

  it("authenticates webhook sources and turns alerts into external monitors", async () => {
    const { source, token } = await createMonitorSource(db, orgId, { name: "Uptime Kuma", kind: "uptime_kuma", defaultPriority: "P2", defaultResponderAgentId: agentId }, owner());
    expect(await authenticateMonitorSource(db, source.id, "wrong-token")).toBeNull();
    expect(await authenticateMonitorSource(db, "not-a-uuid", token)).toBeNull();
    const authed = await authenticateMonitorSource(db, source.id, token);
    expect(authed?.id).toBe(source.id);

    const parsed = parseWebhook("uptime_kuma", { heartbeat: { monitorID: 3, status: 0, msg: "timeout" }, monitor: { id: 3, name: "Plex" } });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(await ingestAlerts(db, authed!, parsed.alerts)).toEqual({ received: 1, applied: 1 });
    const [ext] = await db.select().from(monitors).where(and(eq(monitors.sourceId, source.id), eq(monitors.externalKey, "kuma:3")));
    expect(ext).toMatchObject({ kind: "external", name: "Plex", state: "down", priority: "P2", responderAgentId: agentId });
    expect(await pendingEvents()).toEqual([{ type: "monitor.down", payload: { monitorId: ext!.id } }]);

    // Same key again: same monitor.
    await ingestAlerts(db, authed!, [{ key: "kuma:3", name: "Plex", status: "up", message: "200" }]);
    expect(await db.select().from(monitors).where(eq(monitors.sourceId, source.id))).toHaveLength(1);
    expect((await pendingEvents()).map((e) => e.type)).toEqual(["monitor.up"]);

    await db.update(monitors).set({ enabled: false }).where(eq(monitors.id, ext!.id));
    expect(await ingestAlerts(db, authed!, [{ key: "kuma:3", name: "Plex", status: "down", message: "x" }])).toEqual({ received: 1, applied: 0 });
  });
});
