// The Home Assistant module's background work: health checks (as monitors), MOSS's status sensors in
// Home Assistant, the daily inventory sync, the internet self-heal, and phone notifications for new
// incidents. Every call to Home Assistant goes through the gate, which re-checks the module's config.
import {
  applyHomeAssistantDevices,
  createChangeRequest,
  HA_SELF_HEAL_TEMPLATE,
  healthAlerts,
  incidentRef,
  ingestAlerts,
  loadHomeAssistant,
  mossSensorStates,
  orgsWithModule,
  updateModuleState,
  type HaConfig,
  type HomeAssistantDevices,
  type HomeAssistantHealth,
  type HaState,
} from "@moss/core";
import { agents, incidents, monitors, monitorSources, type Database } from "@moss/db";

import { and, eq } from "drizzle-orm";

export type HaOp = "health" | "devices" | "notify" | "publish";
export type HaResult = { ok: true; result: unknown } | { ok: false; error: string };
/** One Home Assistant call through the gate. Throws only when the gate itself can't be reached. */
export type HaCaller = (orgId: string, op: HaOp, args?: Record<string, unknown>) => Promise<HaResult>;

export function httpHomeAssistant(gateUrl: string, gateToken: string): HaCaller {
  return async (orgId, op, args) => {
    const res = await fetch(`${gateUrl.replace(/\/+$/, "")}/v1/modules/home-assistant/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateToken}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId, args }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Gate returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as HaResult;
  };
}

export const HEALTH_EVERY_MS = 5 * 60_000;
/** Sensors are pushed when they change, and at least this often (Home Assistant forgets them on restart). */
export const PUBLISH_EVERY_MS = 10 * 60_000;
export const INVENTORY_EVERY_MS = 24 * 60 * 60_000;
/** The self-heal acts at most once per incident, and never twice within this time. */
export const SELF_HEAL_COOLDOWN_MS = 30 * 60_000;

type Log = (msg: string, extra?: Record<string, unknown>) => void;
const since = (iso: string | undefined, now: Date) => (iso ? now.getTime() - Date.parse(iso) : Infinity);

async function checkHealth(db: Database, call: HaCaller, orgId: string, c: HaConfig, now: Date) {
  const res = await call(orgId, "health");
  const report = res.ok ? { ok: true as const, health: res.result as HomeAssistantHealth } : { ok: false as const, error: res.error };
  await updateModuleState(db, orgId, "home_assistant", {
    lastHealthAt: now.toISOString(),
    lastHealth: { ok: res.ok, message: res.ok ? `Home Assistant ${(res.result as HomeAssistantHealth).version ?? ""}`.trim() : res.error },
  } satisfies HaState);
  if (!c.sourceId) return;
  const [source] = await db.select().from(monitorSources).where(and(eq(monitorSources.id, c.sourceId), eq(monitorSources.orgId, orgId), eq(monitorSources.enabled, true)));
  if (source) await ingestAlerts(db, source, healthAlerts(report, c), now);
}

async function publishSensors(db: Database, call: HaCaller, orgId: string, state: HaState, now: Date) {
  const states = await mossSensorStates(db, orgId);
  const fingerprint = JSON.stringify(states);
  if (fingerprint === state.lastPublished && since(state.lastPublishAt, now) < PUBLISH_EVERY_MS) return;
  const res = await call(orgId, "publish", { states });
  // On failure, leave the fingerprint alone so the next tick tries again.
  if (res.ok) await updateModuleState(db, orgId, "home_assistant", { lastPublishAt: now.toISOString(), lastPublished: fingerprint } satisfies HaState);
}

/** Pulls Home Assistant's devices and matches them to the inventory. Also run from the module page. */
export async function syncInventory(db: Database, orgId: string, res: HaResult, now = new Date()) {
  const lastInventory = res.ok ? await applyHomeAssistantDevices(db, orgId, (res.result as HomeAssistantDevices).devices, now) : { error: res.error };
  await updateModuleState(db, orgId, "home_assistant", { lastInventoryAt: now.toISOString(), lastInventory } satisfies HaState);
  return lastInventory;
}

/**
 * Self-heal: once the chosen monitor has been down for the configured time, with an open incident, MOSS
 * raises the pre-approved power-cycle change for the chosen agent. The agent is then told to run it and
 * verify (the change.approved event), like any approved change. Once per incident.
 */
export async function selfHeal(db: Database, orgId: string, c: HaConfig, state: HaState, now: Date, log?: Log): Promise<string | null> {
  const s = c.selfHeal;
  if (!s.enabled || !s.monitorId || !s.entity || !s.agentId) return null;
  const [m] = await db.select().from(monitors).where(and(eq(monitors.id, s.monitorId), eq(monitors.orgId, orgId)));
  if (!m || m.state !== "down" || !m.openIncidentId) return null;
  if (now.getTime() - m.stateChangedAt.getTime() < s.afterMinutes * 60_000) return null;
  if (state.selfHealIncidentId === m.openIncidentId || since(state.selfHealAt, now) < SELF_HEAL_COOLDOWN_MS) return null;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, m.openIncidentId));
  if (!inc || inc.status === "resolved" || inc.status === "closed") return null;
  const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, s.agentId));
  if (agent?.status !== "active") {
    log?.("self-heal skipped: agent not active", { orgId, agentId: s.agentId });
    return null;
  }
  // Recorded first, so a failure below can't turn into a power-cycle every minute.
  await updateModuleState(db, orgId, "home_assistant", { selfHealIncidentId: inc.id, selfHealAt: now.toISOString() } satisfies HaState);
  const change = await createChangeRequest(
    db,
    orgId,
    {
      type: "standard",
      standardTemplateKey: HA_SELF_HEAL_TEMPLATE,
      title: `Power-cycle ${s.entity} to bring back ${m.name}`,
      description:
        `"${m.name}" has been down since ${m.stateChangedAt.toISOString()} (${incidentRef(inc.number)}). The Home Assistant module's ` +
        `self-heal turns ${s.entity} off for ${s.offSeconds} seconds and back on.`,
      verificationPlan:
        `After the power-cycle, give the device a few minutes to restart, then run monitor_check_now on monitor ${m.id} ` +
        `until it is up (try a few times over about five minutes). Comment on ${incidentRef(inc.number)} with the result.`,
      rollbackPlan: `If ${s.entity} is still off afterwards, turn it back on in Home Assistant. If the monitor stays down, leave the incident open for a person.`,
      incidentId: inc.id,
      forAgentId: s.agentId,
    },
    { type: "system", id: null },
  );
  log?.("self-heal change raised", { orgId, changeId: change.id, monitorId: m.id });
  return change.id;
}

/** One pass over every org with the module on. Each feature runs on its own schedule and fails on its own. */
export async function runHomeAssistantTick(db: Database, call: HaCaller, opts: { now?: Date; log?: Log } = {}) {
  const now = opts.now ?? new Date();
  for (const orgId of await orgsWithModule(db, "home_assistant")) {
    const { config: c, state } = await loadHomeAssistant(db, orgId);
    if (!c.host) continue;
    const step = async (name: string, due: boolean, fn: () => Promise<unknown>) => {
      if (!due) return;
      try {
        await fn();
      } catch (err) {
        opts.log?.(`home assistant ${name} failed`, { orgId, error: (err as Error).message });
      }
    };
    await step("health check", c.health.enabled && since(state.lastHealthAt, now) >= HEALTH_EVERY_MS, () => checkHealth(db, call, orgId, c, now));
    await step("sensors", c.sensors.enabled, () => publishSensors(db, call, orgId, state, now));
    await step("inventory sync", c.inventory.enabled && since(state.lastInventoryAt, now) >= INVENTORY_EVERY_MS, async () => syncInventory(db, orgId, await call(orgId, "devices"), now));
    await step("self-heal", c.selfHeal.enabled, () => selfHeal(db, orgId, c, state, now, opts.log));
  }
}

const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 } as const;

/** incident.created: tell the module's notify services, if the incident is important enough. */
export async function notifyIncident(db: Database, call: HaCaller, incidentId: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) return;
  const { enabled, config: c } = await loadHomeAssistant(db, inc.orgId);
  if (!enabled || !c.host || !c.notify.enabled || PRIORITY_RANK[inc.priority] > PRIORITY_RANK[c.notify.minPriority]) return;
  const url = c.mossUrl ? `${c.mossUrl.replace(/\/+$/, "")}/incidents/${inc.id}` : undefined;
  const errors: string[] = [];
  for (const service of c.notify.services) {
    const res = await call(inc.orgId, "notify", {
      service,
      title: `${inc.priority} ${incidentRef(inc.number)}: ${inc.title}`.slice(0, 120),
      message: (inc.description.split("\n")[0] || inc.title).slice(0, 1000),
      ...(url ? { url } : {}),
    });
    if (!res.ok) errors.push(`${service}: ${res.error}`);
  }
  // A failed notification is recorded on the module page, not retried: a late "new incident" alert is worse than none.
  await updateModuleState(db, inc.orgId, "home_assistant", { lastNotifyError: errors.length ? errors.join("; ").slice(0, 500) : null } satisfies HaState);
}
