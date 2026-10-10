// Runs due monitor checks through the gate and turns monitor events into incident work for agents.
import { enqueueRun } from "@moss/agent";
import {
  claimDueMonitors,
  getSetting,
  handleMonitorDegraded,
  handleMonitorDown,
  handleMonitorUp,
  incidentRef,
  pruneMonitorResults,
  pruneMonitorRollups,
  recordMonitorResult,
  type CheckResult,
  type MonitorIncidentOutcome,
} from "@moss/core";
import { incidents, monitors, orgs, type Database } from "@moss/db";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

/** Runs one monitor's check. Returns null if the monitor no longer exists (or is external). */
export type MonitorChecker = (monitorId: string) => Promise<CheckResult | null>;

export function httpMonitorChecker(gateUrl: string, gateToken: string): MonitorChecker {
  return async (monitorId) => {
    const res = await fetch(`${gateUrl.replace(/\/+$/, "")}/v1/monitor-checks`, {
      method: "POST",
      headers: { authorization: `Bearer ${gateToken}`, "content-type": "application/json" },
      body: JSON.stringify({ monitorId }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gate returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as CheckResult;
  };
}

/**
 * Claims due monitors and checks them with bounded concurrency. If the gate itself can't be
 * reached the result is not recorded: an outage of MOSS must not look like every service failing.
 */
export async function runDueChecks(
  db: Database,
  check: MonitorChecker,
  opts: { limit?: number; concurrency?: number; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
): Promise<number> {
  const ids = await claimDueMonitors(db, opts.limit ?? 50);
  let next = 0;
  let recorded = 0;
  const lane = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        const result = await check(id);
        if (result && (await recordMonitorResult(db, id, result))) recorded++;
      } catch (err) {
        opts.log?.("monitor check failed", { monitorId: id, error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, ids.length) }, lane));
  return recorded;
}

export async function pruneAllMonitorResults(db: Database): Promise<number> {
  // Rollups go by age for everyone; raw results by each org's setting.
  let total = await pruneMonitorRollups(db);
  for (const org of await db.select({ id: orgs.id }).from(orgs)) {
    total += await pruneMonitorResults(db, org.id, await getSetting(db, org.id, "monitoring.retention_days"));
  }
  return total;
}

async function nudgeAssignee(db: Database, boss: PgBoss, monitorId: string, outcome: MonitorIncidentOutcome, what: "down" | "up") {
  if (outcome.action !== "commented" || !outcome.agentId) return;
  const [inc] = await db.select({ id: incidents.id, number: incidents.number }).from(incidents).where(eq(incidents.id, outcome.incidentId));
  const [m] = await db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, monitorId));
  if (!inc || !m) return;
  const ref = `${incidentRef(inc.number)} (id ${inc.id})`;
  const task =
    what === "up"
      ? `Monitor "${m.name}" (id ${monitorId}) has recovered. It is linked to incident ${ref}. Confirm the service is ` +
        "healthy with monitor_get and your own checks, record the cause and fix in the incident, and resolve it if the " +
        "problem is fixed. If it recovered without anyone fixing it, say so and keep watching for a recurrence."
      : `Monitor "${m.name}" (id ${monitorId}) went down again while incident ${ref} is open. Read the incident and the ` +
        "monitor history with monitor_get, and continue working the incident.";
  await enqueueRun(boss, { agentId: outcome.agentId, trigger: "event", triggerRef: inc.id, task });
}

/** monitor.* events. A new incident needs no run here: its incident.assigned event starts one. */
export async function handleMonitorEvent(db: Database, boss: PgBoss, type: string, payload: Record<string, unknown>): Promise<void> {
  const monitorId = typeof payload.monitorId === "string" ? payload.monitorId : undefined;
  if (!monitorId) return;
  switch (type) {
    case "monitor.down":
      return nudgeAssignee(db, boss, monitorId, await handleMonitorDown(db, monitorId), "down");
    case "monitor.up": {
      const downSince = new Date(typeof payload.downSince === "string" ? payload.downSince : Date.now());
      return nudgeAssignee(db, boss, monitorId, await handleMonitorUp(db, monitorId, downSince), "up");
    }
    case "monitor.degraded":
      await handleMonitorDegraded(db, monitorId);
      return;
  }
}
