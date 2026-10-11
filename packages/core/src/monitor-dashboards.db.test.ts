// Monitoring dashboards: who sees and edits them, the starter dashboard, and what widgets show.
import { monitorResults, monitors, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDashboard,
  dashboardData,
  deleteDashboard,
  ensureStarterDashboard,
  getDashboard,
  latestMetric,
  listDashboards,
  updateDashboard,
} from "./services/monitor-dashboards.js";
import { createMonitor } from "./services/monitors.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe.skipIf(!TEST_DATABASE_URL)("monitoring dashboards (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  const admin = { userId: "", canManage: true };
  const viewer = { userId: "", canManage: false };
  let pingId: string;
  let upsId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_dashboards"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    admin.userId = boot.owner.id;
    viewer.userId = "00000000-0000-4000-8000-000000000001";
    const sys = { type: "system" as const, id: null };
    pingId = (await createMonitor(db, orgId, { name: "Router", kind: "ping", target: "192.168.1.1" }, sys)).id;
    upsId = (await createMonitor(db, orgId, { name: "UPS load", kind: "ha_sensor", target: "sensor.ups_load", config: { unit: "%" } }, sys)).id;
  });
  afterAll(() => close?.());

  it("makes a shared starter dashboard once, from the monitors", async () => {
    const starter = await ensureStarterDashboard(db, orgId, { type: "user", id: admin.userId });
    expect(starter).toMatchObject({ name: "Overview", shared: true });
    expect(starter!.widgets.map((w) => w.type)).toEqual(["status", "incidents", "history", "graph", "value"]);
    expect(starter!.widgets.find((w) => w.type === "graph")!.monitorIds).toEqual([pingId]);
    expect(await ensureStarterDashboard(db, orgId, { type: "user", id: admin.userId })).toBeNull();
  });

  it("keeps personal dashboards to their owner, and shared ones to people who manage monitoring", async () => {
    const mine = await createDashboard(db, orgId, admin, { name: "Mine", widgets: [{ type: "note", text: "hello" }] });
    expect(mine.widgets[0]).toMatchObject({ type: "note", w: 4, h: 2, text: "hello" });
    expect(await getDashboard(db, orgId, viewer.userId, mine.id)).toBeNull();
    expect((await listDashboards(db, orgId, viewer.userId)).map((d) => d.name)).toEqual(["Overview"]);
    await expect(createDashboard(db, orgId, viewer, { name: "Team", shared: true })).rejects.toThrow(/manage monitoring/);
    const overview = (await listDashboards(db, orgId, viewer.userId))[0]!;
    await expect(updateDashboard(db, orgId, viewer, overview.id, { name: "Mine now", shared: true })).rejects.toThrow(/manage monitoring/);
    await expect(deleteDashboard(db, orgId, viewer, overview.id)).rejects.toThrow(/can't delete/);
    await expect(createDashboard(db, orgId, admin, { name: "Bad", widgets: [{ type: "graph", w: 20 } as never] })).rejects.toThrow(/widgets\.0\.w/);
    await deleteDashboard(db, orgId, admin, mine.id);
  });

  it("gathers each widget's data", async () => {
    const now = new Date();
    await db.update(monitors).set({ state: "up", lastResult: { ok: true, message: "ok", at: now.toISOString(), latencyMs: 4 } }).where(eq(monitors.id, pingId));
    await db.update(monitors).set({ state: "degraded", lastResult: { ok: true, message: "23%", at: now.toISOString(), value: 23, unit: "%" } }).where(eq(monitors.id, upsId));
    await db.insert(monitorResults).values([
      { monitorId: pingId, at: new Date(now.getTime() - 60_000), ok: true, latencyMs: 4 },
      { monitorId: pingId, at: new Date(now.getTime() - 30_000), ok: false },
      { monitorId: upsId, at: new Date(now.getTime() - 60_000), ok: true, value: 21 },
    ]);
    const widgets = [
      { id: "g", type: "graph" as const, w: 6, h: 2, metric: "latency", range: "1h" as const, monitorIds: [pingId] },
      { id: "v", type: "value" as const, w: 3, h: 1, metric: "value", range: "1h" as const, monitorIds: [upsId] },
      { id: "h", type: "history" as const, w: 12, h: 2, range: "1h" as const },
      { id: "s", type: "status" as const, w: 6, h: 2 },
      { id: "t", type: "top" as const, w: 4, h: 2, metric: "latency" },
    ];
    const data = await dashboardData(db, orgId, widgets, now);
    expect(data.g).toMatchObject({ type: "graph", resolution: "raw", series: [{ monitor: { name: "Router" }, points: [{ avg: 4 }] }] });
    expect(data.v).toMatchObject({ type: "value", value: 23, monitor: { unit: "%" }, points: [{ avg: 21 }] });
    const history = data.h as Extract<typeof data.h, { type: "history" }>;
    expect(history.rows.find((r) => r.monitor.id === pingId)!.uptime).toBe(0.5);
    expect(data.s).toMatchObject({ type: "status", monitors: [{ name: "Router", state: "up" }, { name: "UPS load", state: "degraded" }] });
    expect(data.t).toEqual({ type: "top", rows: [{ monitor: expect.objectContaining({ name: "Router" }), value: 4 }] });
    expect(latestMetric({ state: "down", lastResult: null }, "up")).toBe(0);
  });
});
