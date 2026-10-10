// The Home Assistant module: its config, and the logic behind each feature that doesn't need the network
// (turning a health report into monitor alerts, matching Home Assistant's devices to assets, working out
// MOSS's own sensor values). The calls to Home Assistant itself are made by the gate.
import { assets, changeRequests, incidents, monitors, networks, type Database } from "@moss/db";
import { contains, parseRange } from "@moss/policy";
import type { HomeAssistantDevice, HomeAssistantHealth } from "@moss/tools";
export type { HomeAssistantDevice, HomeAssistantDevices, HomeAssistantHealth } from "@moss/tools";
import { and, count, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { getSetting } from "../store/settings-store.js";
import { loadModule } from "./modules.js";

/** The secret holding the long-lived access token. */
export const HA_TOKEN_SECRET = "homeassistant-token";

/** Tools agents can be given for Home Assistant (reads), and every tool the token may be used with. */
export const HA_AGENT_READ_TOOLS = ["homeassistant_states", "homeassistant_health", "homeassistant_logs", "homeassistant_devices"];
export const HA_TOKEN_TOOLS = [...HA_AGENT_READ_TOOLS, "homeassistant_switch", "homeassistant_power_cycle", "homeassistant_notify", "homeassistant_publish"];

const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const uuid = z.uuid();
const off = <T extends z.ZodRawShape>(shape: T) => z.object({ enabled: z.boolean().default(false), ...shape });

export const haConfigSchema = z.object({
  host: z.string().regex(IPV4, "Home Assistant's IPv4 address, e.g. 10.0.0.20").optional().catch(undefined),
  port: z.number().int().min(1).max(65535).default(8123).catch(8123),
  scheme: z.enum(["http", "https"]).default("http").catch("http"),
  verifyTls: z.boolean().default(false).catch(false),
  /** MOSS's own address as people's phones reach it, for links in notifications. */
  mossUrl: z.string().regex(/^https?:\/\/[^\s/]+(:\d+)?\/?$/).optional().catch(undefined),
  /** The webhook source alerts and health checks come in through (created on first use). */
  sourceId: uuid.optional().catch(undefined),
  alerts: off({}).default({ enabled: false }).catch({ enabled: false }),
  health: off({ unavailableThreshold: z.number().int().min(1).max(10_000).default(10) })
    .default({ enabled: false, unavailableThreshold: 10 })
    .catch({ enabled: false, unavailableThreshold: 10 }),
  notify: off({
    services: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(5).default([]),
    minPriority: z.enum(PRIORITIES).default("P2"),
  })
    .default({ enabled: false, services: [], minPriority: "P2" })
    .catch({ enabled: false, services: [], minPriority: "P2" }),
  sensors: off({}).default({ enabled: false }).catch({ enabled: false }),
  inventory: off({}).default({ enabled: false }).catch({ enabled: false }),
  selfHeal: off({
    monitorId: uuid.optional(),
    entity: z.string().regex(/^switch\.[a-z0-9_]{1,64}$/).optional(),
    offSeconds: z.number().int().min(5).max(120).default(30),
    afterMinutes: z.number().int().min(1).max(120).default(5),
    agentId: uuid.optional(),
  })
    .default({ enabled: false, offSeconds: 30, afterMinutes: 5 })
    .catch({ enabled: false, offSeconds: 30, afterMinutes: 5 }),
  logReview: off({ agentId: uuid.optional(), scheduleId: uuid.optional(), cron: z.string().max(100).default("0 7 * * *") })
    .default({ enabled: false, cron: "0 7 * * *" })
    .catch({ enabled: false, cron: "0 7 * * *" }),
});

export type HaConfig = z.infer<typeof haConfigSchema>;

export function parseHaConfig(raw: unknown): HaConfig {
  return haConfigSchema.parse(raw && typeof raw === "object" ? raw : {});
}

/** Runtime state MOSS keeps for the module. */
export interface HaState {
  lastHealthAt?: string;
  lastHealth?: { ok: boolean; message: string };
  lastPublishAt?: string;
  lastPublished?: string;
  lastInventoryAt?: string;
  lastInventory?: { matched: number; created: number; locked: number; skipped: number } | { error: string };
  /** Self-heal: the incident it last acted on, and when. */
  selfHealIncidentId?: string;
  selfHealAt?: string;
  lastNotifyError?: string | null;
}

export async function loadHomeAssistant(db: Pick<Database, "select">, orgId: string) {
  const row = await loadModule(db, orgId, "home_assistant");
  return { enabled: row.enabled, config: parseHaConfig(row.config), state: row.state as HaState, updatedAt: row.updatedAt };
}

/** Connection arguments every Home Assistant tool takes. The token is a handle; only the gate resolves it. */
export function haConnectionArgs(c: HaConfig) {
  if (!c.host) throw new Error("Set Home Assistant's address first");
  return { target: c.host, port: c.port, scheme: c.scheme, verifyTls: c.verifyTls, token: `secret:${HA_TOKEN_SECRET}` };
}

// --- Health ---------------------------------------------------------------------------------------

const list = (items: string[], max = 5) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));

/** A health report (or the error from trying to get one) as monitor alerts, one external monitor each. */
export function healthAlerts(report: { ok: true; health: HomeAssistantHealth } | { ok: false; error: string }, c: HaConfig): ParsedAlert[] {
  if (!report.ok) return [{ key: "ha:reachable", name: "Home Assistant", status: "down", message: report.error.slice(0, 500) }];
  const h = report.health;
  const alerts: ParsedAlert[] = [{ key: "ha:reachable", name: "Home Assistant", status: "up", message: `Home Assistant ${h.version ?? ""} is answering`.replace("  ", " ") }];
  if (h.integrations) {
    const failed = h.integrations.failed;
    alerts.push({
      key: "ha:integrations",
      name: "Home Assistant integrations",
      status: failed.length ? "down" : "up",
      message: failed.length
        ? `${failed.length} integration(s) not working: ${list(failed.map((f) => `${f.title ?? f.domain} (${f.state}${f.reason ? `: ${f.reason}` : ""})`))}`
        : `All ${h.integrations.total} integrations loaded`,
    });
  }
  alerts.push({
    key: "ha:updates",
    name: "Home Assistant updates",
    status: h.updates.length ? "degraded" : "up",
    message: h.updates.length ? `${h.updates.length} update(s) available: ${list(h.updates.map((u) => `${u.name ?? u.entity} ${u.installed ?? "?"} → ${u.latest ?? "?"}`))}` : "Everything is up to date",
  });
  const n = h.unavailable.count;
  alerts.push({
    key: "ha:unavailable",
    name: "Home Assistant unavailable entities",
    status: n >= c.health.unavailableThreshold ? "degraded" : "up",
    message: n ? `${n} unavailable: ${list(h.unavailable.entities.map((e) => e.name ?? e.entity), 8)}` : "No unavailable entities",
  });
  return alerts;
}

// --- Inventory ------------------------------------------------------------------------------------

export interface DeviceSyncResult {
  matched: number;
  created: number;
  locked: number;
  skipped: number;
}

async function allowedRanges(db: Pick<Database, "select">, orgId: string) {
  const rows = await db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, orgId));
  const ranges = (status: string) => rows.filter((r) => r.status === status).flatMap((r) => parseRange(r.cidr) ?? []);
  return { allowed: ranges("allowed"), offLimits: ranges("off_limits") };
}

/** A name nobody chose: the address itself, or the scan's "vendor address" default. */
function autoNamed(a: typeof assets.$inferSelect): boolean {
  const ip = a.primaryIp ?? "";
  return !a.name.trim() || a.name === ip || a.name === "unknown" || a.name === a.primaryMac || (!!a.vendor && a.name === `${a.vendor} ${ip}`);
}

/**
 * Matches Home Assistant's devices to assets by MAC, then IP. Unlocked matches get Home Assistant's
 * name (only over an automatic one), maker and model (only where empty) and its details under
 * attributes.homeAssistant. A device with an address in an allowed network that matches nothing is added.
 */
export async function applyHomeAssistantDevices(db: Database, orgId: string, devices: HomeAssistantDevice[], now = new Date()): Promise<DeviceSyncResult> {
  const result: DeviceSyncResult = { matched: 0, created: 0, locked: 0, skipped: 0 };
  const { allowed, offLimits } = await allowedRanges(db, orgId);
  for (const d of devices) {
    if (!d.macs.length && !d.ips.length) {
      result.skipped++; // cloud services, helpers, the sun...
      continue;
    }
    const live = ne(assets.status, "retired");
    const [byMac] = d.macs.length ? await db.select().from(assets).where(and(eq(assets.orgId, orgId), inArray(assets.primaryMac, d.macs), live)).limit(1) : [];
    const [byIp] =
      byMac || !d.ips.length
        ? []
        : await db
            .select()
            .from(assets)
            .where(and(eq(assets.orgId, orgId), sql`host(${assets.primaryIp}) in (${sql.join(d.ips.map((ip) => sql`${ip}`), sql`, `)})`, live))
            .orderBy(desc(assets.lastSeenAt))
            .limit(1);
    // An IP match whose MAC differs is another device on that address now.
    const match = byMac ?? (byIp && (!byIp.primaryMac || !d.macs.length || d.macs.includes(byIp.primaryMac)) ? byIp : undefined);
    const details = { deviceId: d.id, name: d.name ?? null, area: d.area ?? null, manufacturer: d.manufacturer ?? null, model: d.model ?? null, syncedAt: now.toISOString() };

    if (match) {
      result.matched++;
      if (match.locked) {
        result.locked++;
        continue;
      }
      const patch: Partial<typeof assets.$inferInsert> = { attributes: { ...match.attributes, homeAssistant: details }, updatedAt: now };
      if (d.name && autoNamed(match)) patch.name = d.name.slice(0, 200);
      if (d.manufacturer && !match.vendor) patch.vendor = d.manufacturer.slice(0, 200);
      if (d.model && !match.model) patch.model = d.model.slice(0, 200);
      if (d.macs[0] && !match.primaryMac) patch.primaryMac = d.macs[0];
      await db.update(assets).set(patch).where(eq(assets.id, match.id));
      continue;
    }

    const ip = d.ips.find((addr) => {
      const r = parseRange(addr);
      return r && allowed.some((a) => contains(a, r)) && !offLimits.some((o) => contains(o, r));
    });
    if (!ip) {
      result.skipped++;
      continue;
    }
    await db.insert(assets).values({
      orgId,
      name: (d.name ?? ip).slice(0, 200),
      vendor: d.manufacturer?.slice(0, 200) ?? null,
      model: d.model?.slice(0, 200) ?? null,
      primaryIp: ip,
      primaryMac: d.macs[0] ?? null,
      attributes: { homeAssistant: details },
      source: "integration:home_assistant",
      confidence: 70,
    });
    result.created++;
  }
  return result;
}

// --- MOSS's sensors in Home Assistant ----------------------------------------------------------

export interface MossSensorState {
  entity: string;
  state: string;
  attributes: Record<string, string | number | boolean>;
}

export async function mossSensorStates(db: Database, orgId: string): Promise<MossSensorState[]> {
  const open = and(eq(incidents.orgId, orgId), notInArray(incidents.status, ["resolved", "closed"]));
  const [openIncidents, down, [pending], paused] = await Promise.all([
    db.select({ priority: incidents.priority }).from(incidents).where(open),
    db.select({ name: monitors.name }).from(monitors).where(and(eq(monitors.orgId, orgId), eq(monitors.state, "down"))).orderBy(monitors.name),
    db.select({ n: count() }).from(changeRequests).where(and(eq(changeRequests.orgId, orgId), eq(changeRequests.status, "submitted"))),
    getSetting(db, orgId, "agents.kill_switch"),
  ]);
  const highest = openIncidents.map((i) => i.priority).sort()[0] ?? "none";
  return [
    {
      entity: "sensor.moss_open_incidents",
      state: String(openIncidents.length),
      attributes: { friendly_name: "MOSS open incidents", unit_of_measurement: "incidents", icon: "mdi:alert-circle-outline", highest_priority: highest },
    },
    {
      entity: "sensor.moss_monitors_down",
      state: String(down.length),
      attributes: { friendly_name: "MOSS monitors down", unit_of_measurement: "monitors", icon: "mdi:lan-disconnect", down: list(down.map((m) => m.name)).slice(0, 200) },
    },
    {
      entity: "sensor.moss_changes_pending",
      state: String(pending?.n ?? 0),
      attributes: { friendly_name: "MOSS changes waiting for approval", unit_of_measurement: "changes", icon: "mdi:clipboard-check-outline" },
    },
    { entity: "binary_sensor.moss_agents_paused", state: paused ? "on" : "off", attributes: { friendly_name: "MOSS agents paused", icon: "mdi:pause-octagon" } },
  ];
}

// --- Internet self-heal -------------------------------------------------------------------------

/** The pre-approved standard change the self-heal raises. Its plan is fixed when the module is saved. */
export const HA_SELF_HEAL_TEMPLATE = "home-assistant-self-heal";

/** What the executing agent needs: the plug, its change, the monitor to verify, and the incident to update. */
export const HA_SELF_HEAL_AGENT_TOOLS = [
  "homeassistant_power_cycle",
  "change_get",
  "change_execute",
  "change_complete",
  "change_rollback",
  "monitor_get",
  "monitor_check_now",
  "incident_get",
  "incident_comment",
];

/** The skill the log-review agent is given. */
export const HA_SKILL = "home-assistant";

export function selfHealTemplate(c: HaConfig, monitorName: string) {
  const entity = c.selfHeal.entity;
  if (!entity) throw new Error("Choose the smart plug the modem is on");
  return {
    key: HA_SELF_HEAL_TEMPLATE,
    name: `Power-cycle ${entity} (Home Assistant self-heal)`,
    description: `Turns ${entity} off for ${c.selfHeal.offSeconds} seconds and back on, when "${monitorName}" has been down for ${c.selfHeal.afterMinutes} minutes.`,
    risk: "low" as const,
    calls: [{ tool: "homeassistant_power_cycle", args: { ...haConnectionArgs(c), entity, offSeconds: c.selfHeal.offSeconds } }],
    params: {},
  };
}
