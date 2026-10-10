// Monitoring dashboards (Monitoring > Dashboards): personal ones only their owner sees, and shared ones everyone
// who can read monitoring sees and those who manage monitoring edit. Each is a list of widgets; this module
// stores them, makes a starter one from the monitors, and gathers what each widget shows.
import { incidents, monitorDashboards, monitors, type Database, type DashboardWidget } from "@moss/db";
import { and, asc, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";
import { monitorSeries, monitorUptime, type SeriesPoint, type SeriesResolution } from "./monitor-history.js";

export const WIDGET_TYPES = ["graph", "gauge", "value", "history", "status", "top", "incidents", "note"] as const;
export const DASHBOARD_RANGES = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "90d": 2160, "1y": 8760 } as const;

const finite = z.number().finite().optional();
export const widgetSchema = z
  .object({
    id: z.string().min(1).max(64).default(() => randomUUID()),
    type: z.enum(WIDGET_TYPES),
    title: z.string().trim().max(80).optional(),
    w: z.number().int().min(2).max(12).default(4),
    h: z.number().int().min(1).max(4).default(2),
    monitorIds: z.array(z.string().uuid()).max(20).optional(),
    metric: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/)
      .optional(),
    range: z.enum(Object.keys(DASHBOARD_RANGES) as [keyof typeof DASHBOARD_RANGES, ...(keyof typeof DASHBOARD_RANGES)[]]).optional(),
    min: finite,
    max: finite,
    warn: finite,
    crit: finite,
    unit: z.string().max(12).optional(),
    count: z.number().int().min(1).max(25).optional(),
    order: z.enum(["desc", "asc"]).optional(),
    text: z.string().max(4000).optional(),
  })
  .strict();

export const dashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  shared: z.boolean().default(false),
  widgets: z.array(widgetSchema).max(40).default([]),
});
export type DashboardInput = z.input<typeof dashboardInputSchema>;
export type MonitorDashboard = typeof monitorDashboards.$inferSelect;

export class DashboardError extends Error {}

/** Who is asking: their id, and whether they may manage monitoring (which editing shared dashboards needs). */
export interface DashboardViewer {
  userId: string;
  canManage: boolean;
}

const visible = (orgId: string, userId: string) => and(eq(monitorDashboards.orgId, orgId), or(eq(monitorDashboards.shared, true), eq(monitorDashboards.ownerId, userId)));

export function canEditDashboard(d: Pick<MonitorDashboard, "shared" | "ownerId">, v: DashboardViewer): boolean {
  return d.shared ? v.canManage : d.ownerId === v.userId;
}

export async function listDashboards(db: Database, orgId: string, userId: string) {
  return db.select().from(monitorDashboards).where(visible(orgId, userId)).orderBy(desc(monitorDashboards.shared), asc(monitorDashboards.name));
}

export async function getDashboard(db: Database, orgId: string, userId: string, id: string): Promise<MonitorDashboard | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [d] = await db.select().from(monitorDashboards).where(and(eq(monitorDashboards.id, id), visible(orgId, userId)));
  return d ?? null;
}

function parse(input: unknown) {
  const parsed = dashboardInputSchema.safeParse(input);
  if (!parsed.success) throw new DashboardError(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
  return parsed.data;
}

export async function createDashboard(db: Database, orgId: string, v: DashboardViewer, input: DashboardInput) {
  const d = parse(input);
  if (d.shared && !v.canManage) throw new DashboardError("Sharing a dashboard needs permission to manage monitoring.");
  const [row] = await db.insert(monitorDashboards).values({ orgId, ownerId: v.userId, ...d }).returning();
  await writeAudit(db, { orgId, actorType: "user", actorId: v.userId, action: "dashboard.create", targetType: "dashboard", targetId: row!.id, details: { name: d.name, shared: d.shared } });
  return row!;
}

export async function updateDashboard(db: Database, orgId: string, v: DashboardViewer, id: string, input: DashboardInput) {
  const existing = await getDashboard(db, orgId, v.userId, id);
  if (!existing) throw new DashboardError("Dashboard not found.");
  if (!canEditDashboard(existing, v)) throw new DashboardError(existing.shared ? "Editing a shared dashboard needs permission to manage monitoring." : "Only its owner can edit this dashboard.");
  const d = parse(input);
  if (d.shared && !v.canManage) throw new DashboardError("Sharing a dashboard needs permission to manage monitoring.");
  const [row] = await db.update(monitorDashboards).set({ ...d, updatedAt: new Date() }).where(eq(monitorDashboards.id, id)).returning();
  await writeAudit(db, { orgId, actorType: "user", actorId: v.userId, action: "dashboard.update", targetType: "dashboard", targetId: id, details: { name: d.name, shared: d.shared, widgets: d.widgets.length } });
  return row!;
}

export async function deleteDashboard(db: Database, orgId: string, v: DashboardViewer, id: string) {
  const existing = await getDashboard(db, orgId, v.userId, id);
  if (!existing) throw new DashboardError("Dashboard not found.");
  if (!canEditDashboard(existing, v)) throw new DashboardError("You can't delete this dashboard.");
  await db.delete(monitorDashboards).where(eq(monitorDashboards.id, id));
  await writeAudit(db, { orgId, actorType: "user", actorId: v.userId, action: "dashboard.delete", targetType: "dashboard", targetId: id, details: { name: existing.name } });
}

/** A first dashboard from the monitors there are: what's up, history, response times, and each metric monitor. */
export function starterWidgets(list: { id: string; kind: string; config: { metric?: string; unit?: string } }[]): DashboardWidget[] {
  const w = (x: Omit<DashboardWidget, "id">): DashboardWidget => ({ id: randomUUID(), ...x });
  const timed = list.filter((m) => ["ping", "tcp", "http", "tls", "dns"].includes(m.kind)).slice(0, 6);
  const metrics = list.filter((m) => ["snmp", "host", "ha_sensor"].includes(m.kind)).slice(0, 6);
  return [
    w({ type: "status", title: "Status", w: 8, h: 2 }),
    w({ type: "incidents", title: "Open incidents", w: 4, h: 2 }),
    w({ type: "history", title: "Last 24 hours", w: 12, h: 2, range: "24h" }),
    ...(timed.length ? [w({ type: "graph", title: "Response times", w: 12, h: 2, metric: "latency", range: "24h", monitorIds: timed.map((m) => m.id) })] : []),
    ...metrics.map((m) => w({ type: "value", w: 4, h: 1, monitorIds: [m.id], metric: m.config.metric ?? "value", range: "24h", unit: m.config.unit })),
  ];
}

/** Makes the shared "Overview" dashboard the first time someone opens Dashboards, if there are monitors. */
export async function ensureStarterDashboard(db: Database, orgId: string, actor: Actor): Promise<MonitorDashboard | null> {
  const [any] = await db.select({ id: monitorDashboards.id }).from(monitorDashboards).where(eq(monitorDashboards.orgId, orgId)).limit(1);
  if (any) return null;
  const list = await db.select({ id: monitors.id, kind: monitors.kind, config: monitors.config }).from(monitors).where(and(eq(monitors.orgId, orgId), eq(monitors.enabled, true))).orderBy(asc(monitors.name));
  if (!list.length) return null;
  const [row] = await db
    .insert(monitorDashboards)
    .values({ orgId, ownerId: actor.type === "user" ? actor.id : null, name: "Overview", shared: true, widgets: starterWidgets(list) })
    .returning();
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "dashboard.create", targetType: "dashboard", targetId: row!.id, details: { name: "Overview", starter: true } });
  return row!;
}

// --- What widgets show --------------------------------------------------------------------------

type MonitorRow = typeof monitors.$inferSelect;

/** The latest value of a metric for a monitor: latency (ms), up (1/0), the main value, or a named one. */
export function latestMetric(m: Pick<MonitorRow, "state" | "lastResult">, metric = "value"): number | null {
  const r = m.lastResult;
  if (metric === "up") return m.state === "up" || m.state === "degraded" ? 1 : m.state === "down" ? 0 : null;
  if (!r) return null;
  if (metric === "latency") return r.latencyMs ?? null;
  if (metric === "value") return r.value ?? null;
  return r.values?.[metric] ?? null;
}

export interface MonitorBrief {
  id: string;
  name: string;
  kind: string;
  state: string;
  unit?: string;
}

export type WidgetData =
  | { type: "graph"; resolution: SeriesResolution; from: number; to: number; series: { monitor: MonitorBrief; points: SeriesPoint[] }[] }
  | { type: "value" | "gauge"; monitor: MonitorBrief | null; value: number | null; points: SeriesPoint[] }
  | { type: "history"; slots: number; rows: { monitor: MonitorBrief; slots: (number | null)[]; uptime: number | null }[] }
  | { type: "status"; monitors: MonitorBrief[] }
  | { type: "top"; rows: { monitor: MonitorBrief; value: number }[] }
  | { type: "incidents"; incidents: { id: string; number: number; title: string; priority: string; status: string }[] }
  | { type: "note" };

const brief = (m: MonitorRow): MonitorBrief => ({ id: m.id, name: m.name, kind: m.kind, state: m.state, unit: m.lastResult?.unit ?? m.config.unit });
const HISTORY_SLOTS = 48;

/** Everything a dashboard's widgets show, gathered in one go (only the org's own monitors). */
export async function dashboardData(db: Database, orgId: string, widgets: DashboardWidget[], now = new Date()): Promise<Record<string, WidgetData>> {
  const all = await db.select().from(monitors).where(eq(monitors.orgId, orgId)).orderBy(asc(monitors.name));
  const byId = new Map(all.map((m) => [m.id, m]));
  const pick = (ids?: string[]) => (ids?.length ? ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) : all.filter((m) => m.kind !== "external" || m.enabled));
  const span = (w: DashboardWidget) => DASHBOARD_RANGES[w.range ?? "24h"] * 3_600_000;
  const out: Record<string, WidgetData> = {};

  await Promise.all(
    widgets.map(async (w) => {
      const from = new Date(now.getTime() - span(w));
      switch (w.type) {
        case "graph": {
          const list = pick(w.monitorIds).slice(0, 20);
          const res = await monitorSeries(db, orgId, list.map((m) => m.id), w.metric ?? "latency", from, now);
          out[w.id] = { type: "graph", resolution: res.resolution, from: from.getTime(), to: now.getTime(), series: list.map((m) => ({ monitor: brief(m), points: res.series[m.id] ?? [] })) };
          return;
        }
        case "value":
        case "gauge": {
          const m = pick(w.monitorIds)[0];
          if (!m || !w.monitorIds?.length) return void (out[w.id] = { type: w.type, monitor: null, value: null, points: [] });
          const points = w.type === "value" ? ((await monitorSeries(db, orgId, [m.id], w.metric ?? "value", from, now)).series[m.id] ?? []) : [];
          out[w.id] = { type: w.type, monitor: brief(m), value: latestMetric(m, w.metric), points };
          return;
        }
        case "history": {
          const list = pick(w.monitorIds).filter((m) => m.kind !== "external").slice(0, 20);
          const ids = list.map((m) => m.id);
          const [{ series }, uptime] = await Promise.all([monitorSeries(db, orgId, ids, "up", from, now), monitorUptime(db, orgId, ids, from, now)]);
          const slotMs = span(w) / HISTORY_SLOTS;
          out[w.id] = {
            type: "history",
            slots: HISTORY_SLOTS,
            rows: list.map((m) => {
              const sums = Array.from({ length: HISTORY_SLOTS }, () => ({ n: 0, up: 0 }));
              for (const p of series[m.id] ?? []) {
                const i = Math.min(HISTORY_SLOTS - 1, Math.max(0, Math.floor((p.t - from.getTime()) / slotMs)));
                sums[i]!.n++;
                sums[i]!.up += p.avg;
              }
              return { monitor: brief(m), slots: sums.map((s) => (s.n ? s.up / s.n : null)), uptime: uptime[m.id] ?? null };
            }),
          };
          return;
        }
        case "status":
          out[w.id] = { type: "status", monitors: pick(w.monitorIds).filter((m) => m.enabled).map(brief) };
          return;
        case "top": {
          const metric = w.metric ?? "latency";
          const rows = pick(w.monitorIds)
            .flatMap((m) => {
              const value = latestMetric(m, metric);
              return value === null ? [] : [{ monitor: brief(m), value }];
            })
            .sort((a, b) => (w.order === "asc" ? a.value - b.value : b.value - a.value))
            .slice(0, w.count ?? 5);
          out[w.id] = { type: "top", rows };
          return;
        }
        case "incidents": {
          const rows = await db
            .select({ id: incidents.id, number: incidents.number, title: incidents.title, priority: incidents.priority, status: incidents.status })
            .from(incidents)
            .where(and(eq(incidents.orgId, orgId), notInArray(incidents.status, ["resolved", "closed"])))
            .orderBy(asc(incidents.priority), desc(incidents.createdAt))
            .limit(w.count ?? 8);
          out[w.id] = { type: "incidents", incidents: rows };
          return;
        }
        default:
          out[w.id] = { type: "note" };
      }
    }),
  );
  return out;
}

/** Monitors that a dashboard's widgets refer to but which no longer exist (deleted since). */
export async function missingMonitors(db: Database, orgId: string, widgets: DashboardWidget[]): Promise<string[]> {
  const ids = [...new Set(widgets.flatMap((w) => w.monitorIds ?? []))];
  if (!ids.length) return [];
  const found = new Set((await db.select({ id: monitors.id }).from(monitors).where(and(eq(monitors.orgId, orgId), inArray(monitors.id, ids)))).map((m) => m.id));
  return ids.filter((id) => !found.has(id));
}
