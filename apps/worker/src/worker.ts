// The worker: runs agent jobs from the queue, turns agent schedules into jobs, and runs monitor checks.
import {
  enqueueRun,
  ensureQueues,
  HttpGateClient,
  loadLibrary,
  RUN_QUEUE,
  runAgent,
  SCHEDULE_QUEUE,
  syncBuiltInSkills,
  type ClaudeCodeConfig,
  type GateClient,
  type ProviderFactory,
  type RunInput,
} from "@moss/agent";
import { changeRef, dispatchEvents, ensureBuiltInRoles, incidentRef, type StoredEvent } from "@moss/core";
import { agents, agentSchedules, changeRequests, incidents, orgs, type Database } from "@moss/db";
import { createProvider } from "@moss/llm";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { handleMonitorEvent, pruneAllMonitorResults, runDueChecks, type MonitorChecker } from "./monitor-runner.js";

export { enqueueRun, RUN_QUEUE, SCHEDULE_QUEUE };

export interface WorkerConfig {
  db: Database;
  boss: PgBoss;
  gate: GateClient;
  providerFor: ProviderFactory;
  libraryDir?: string;
  /** Runs agents whose model is on a Claude subscription (through the Claude Code CLI). */
  claudeCode?: ClaudeCodeConfig;
  /** Runs monitor checks through the gate. Monitoring is off without it. */
  checkMonitor?: MonitorChecker;
  eventIntervalMs?: number;
  monitorIntervalMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** LLM clients authenticate to the gate's proxy with the service token; the gate adds the real key. */
export function gateProviderFactory(gateUrl: string, gateToken: string): ProviderFactory {
  return (provider) =>
    createProvider({ kind: provider.kind, apiKey: gateToken, baseURL: `${gateUrl.replace(/\/+$/, "")}/v1/llm/${provider.id}` });
}

/** Mirrors enabled agent schedules into pg-boss cron schedules, keyed by schedule id. */
export async function syncSchedules(db: Database, boss: PgBoss): Promise<{ added: number; removed: number }> {
  const rows = await db
    .select({ id: agentSchedules.id, cron: agentSchedules.cron })
    .from(agentSchedules)
    .innerJoin(agents, eq(agentSchedules.agentId, agents.id))
    .where(and(eq(agentSchedules.enabled, true), eq(agents.status, "active")));
  const wanted = new Map(rows.map((r) => [r.id, r.cron]));
  const existing = await boss.getSchedules(SCHEDULE_QUEUE);
  let added = 0;
  let removed = 0;
  for (const s of existing) {
    if (!s.key || wanted.get(s.key) !== s.cron) {
      await boss.unschedule(SCHEDULE_QUEUE, s.key);
      removed++;
    }
  }
  const have = new Set(existing.filter((s) => s.key && wanted.get(s.key) === s.cron).map((s) => s.key));
  for (const [id, cron] of wanted) {
    if (have.has(id)) continue;
    await boss.schedule(SCHEDULE_QUEUE, cron, { scheduleId: id }, { key: id, tz: process.env.TZ ?? "UTC" });
    added++;
  }
  return { added, removed };
}

/** Turns domain events into agent runs. Tasks reference tickets by id; the agent reads them with its tools. */
export async function handleEvent(db: Database, boss: PgBoss, event: StoredEvent): Promise<void> {
  const p = event.payload as Record<string, string | undefined>;
  switch (event.type) {
    case "incident.assigned": {
      if (!p.agentId || !p.incidentId) return;
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, p.incidentId));
      if (!inc || inc.assignedAgentId !== p.agentId || inc.status === "resolved" || inc.status === "closed") return;
      await enqueueRun(boss, {
        agentId: p.agentId,
        trigger: "ticket",
        triggerRef: inc.id,
        task:
          `You have been assigned incident ${incidentRef(inc.number)} (${inc.priority}), id ${inc.id}. Read it with incident_get, ` +
          "investigate, keep it updated with comments, and resolve it once the fix is verified. If fixing it needs a change " +
          "to a system, raise a change request linked to the incident.",
      });
      return;
    }
    case "change.approved":
    case "change.rejected": {
      if (!p.changeId) return;
      const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, p.changeId));
      if (!cr?.requestedByAgentId) return;
      const ref = changeRef(cr.number);
      const task =
        event.type === "change.approved"
          ? `Change ${ref} (id ${cr.id}) has been approved. Read it with change_get, run it with change_execute, carry out ` +
            "its verification plan, then call change_complete (or change_rollback if verification fails). Update the linked incident."
          : `Change ${ref} (id ${cr.id}) was rejected. Read the reason with change_get and update the linked incident; ` +
            "do not attempt the change another way.";
      await enqueueRun(boss, { agentId: cr.requestedByAgentId, trigger: "event", triggerRef: cr.id, task });
      return;
    }
    case "monitor.down":
    case "monitor.up":
    case "monitor.degraded":
      return handleMonitorEvent(db, boss, event.type, p);
    default:
      return; // other events only drive notifications, which are written when the event happens
  }
}

export async function startWorker(cfg: WorkerConfig) {
  const { db, boss } = cfg;
  const log = cfg.log ?? ((msg, extra) => console.log(JSON.stringify({ msg, ...extra })));

  // Built-in roles are re-synced on every boot so upgrades can add permissions.
  for (const org of await db.select({ id: orgs.id }).from(orgs)) await ensureBuiltInRoles(db, org.id);

  if (cfg.libraryDir) {
    const lib = await loadLibrary(cfg.libraryDir);
    for (const org of await db.select({ id: orgs.id }).from(orgs)) await syncBuiltInSkills(db, org.id, lib.skills.values());
    log("library synced", { skills: lib.skills.size, templates: lib.templates.size });
  }

  await ensureQueues(boss);

  await boss.work<RunInput>(RUN_QUEUE, { localConcurrency: 4 }, async ([job]) => {
    if (!job) return;
    log("run started", { agentId: job.data.agentId, trigger: job.data.trigger });
    const outcome = await runAgent({ db, gate: cfg.gate, providerFor: cfg.providerFor, claudeCode: cfg.claudeCode }, job.data);
    log("run finished", { agentId: job.data.agentId, runId: outcome.runId, status: outcome.status });
    return outcome;
  });

  await boss.work<{ scheduleId: string }>(SCHEDULE_QUEUE, async ([job]) => {
    if (!job) return;
    const [s] = await db.select().from(agentSchedules).where(eq(agentSchedules.id, job.data.scheduleId));
    if (!s?.enabled) return;
    await enqueueRun(boss, { agentId: s.agentId, task: s.task, trigger: "schedule", triggerRef: s.id });
  });

  const sync = async () => {
    try {
      const res = await syncSchedules(db, boss);
      if (res.added || res.removed) log("schedules synced", res);
    } catch (err) {
      log("schedule sync failed", { error: (err as Error).message });
    }
  };
  await sync();
  const timer = setInterval(sync, 60_000);

  let dispatching = false;
  const dispatch = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchEvents(db, (e) => handleEvent(db, boss, e), 50);
    } catch (err) {
      log("event dispatch failed", { error: (err as Error).message });
    } finally {
      dispatching = false;
    }
  };
  const eventTimer = setInterval(dispatch, cfg.eventIntervalMs ?? 3_000);

  let checking = false;
  const checkMonitors = async () => {
    if (checking || !cfg.checkMonitor) return;
    checking = true;
    try {
      await runDueChecks(db, cfg.checkMonitor, { log });
    } catch (err) {
      log("monitor checks failed", { error: (err as Error).message });
    } finally {
      checking = false;
    }
  };
  const monitorTimer = setInterval(checkMonitors, cfg.monitorIntervalMs ?? 10_000);
  const prune = () =>
    pruneAllMonitorResults(db).then(
      (n) => n && log("monitor results pruned", { deleted: n }),
      (err) => log("monitor prune failed", { error: (err as Error).message }),
    );
  const pruneTimer = setInterval(prune, 60 * 60_000);
  return {
    stop: async () => {
      clearInterval(timer);
      clearInterval(eventTimer);
      clearInterval(monitorTimer);
      clearInterval(pruneTimer);
      await boss.stop({ graceful: true });
    },
  };
}

export function httpGate(url: string, token: string) {
  return new HttpGateClient(url, token);
}
