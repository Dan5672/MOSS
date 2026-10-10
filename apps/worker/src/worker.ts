// The worker: runs agent jobs from the queue, turns agent schedules into jobs, and runs monitor checks.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chatSnapshot,
  ensureMoss,
  MOSS_TEMPLATE,
  enqueueRun,
  ensureQueues,
  HttpGateClient,
  loadLibrary,
  recordChatReply,
  RUN_QUEUE,
  runAgent,
  SCHEDULE_QUEUE,
  syncBuiltInSkills,
  ensureCoreSkills,
  welcomeFromMoss,
  type ClaudeCodeConfig,
  type GateClient,
  type ProviderFactory,
  type RunInput,
  unansweredConversations,
} from "@moss/agent";
import { actorName, changeRef, dispatchEvents, ensureBuiltInRoles, incidentRef, type StoredEvent } from "@moss/core";
import { agentRuns, agents, agentSchedules, changeNotes, changeRequests, incidentComments, incidents, orgs, type Database } from "@moss/db";
import { createProvider } from "@moss/llm";
import { and, desc, eq, gt, inArray, notInArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { notifyIncident, runHomeAssistantTick, type HaCaller } from "./home-assistant.js";
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
  /** Makes the Home Assistant module's calls through the gate. The module does nothing without it. */
  homeAssistant?: HaCaller;
  homeAssistantIntervalMs?: number;
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

/** The agents a comment @mentions. */
const agentMentions = (mentions: { type: string; id: string }[]) => mentions.filter((m) => m.type === "agent").map((m) => m.id);

/** The active agents among these ids, each once, in order. */
async function activeAgents(db: Database, ids: (string | null)[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return [];
  const rows = await db.select({ id: agents.id, status: agents.status }).from(agents).where(inArray(agents.id, unique));
  return unique.filter((id) => rows.some((r) => r.id === id && r.status === "active"));
}

/** A run that answers a person's comment on an incident: for the assignee, or for an agent they @mentioned. */
async function commentRun(
  db: Database,
  inc: typeof incidents.$inferSelect,
  comment: typeof incidentComments.$inferSelect,
  agentId: string,
): Promise<RunInput> {
  const who = await actorName(db, { type: "user", id: comment.authorUserId });
  const said = `\n\n"${comment.body.slice(0, 2000)}"\n\n`;
  const ref = `incident ${incidentRef(inc.number)} (id ${inc.id})`;
  const reply = "Read the incident with incident_get, then reply with incident_comment";
  return {
    agentId,
    trigger: "ticket",
    triggerRef: inc.id,
    requestedByUserId: comment.authorUserId ?? undefined,
    task:
      agentId === inc.assignedAgentId
        ? `${who} commented on ${ref}, which is assigned to you:${said}${reply}: answer their question, or say what you'll do next. ` +
          "If they asked for something, do it (anything that changes a system needs a change request)."
        : `${who} mentioned you in a comment on ${ref}:${said}${reply} to answer them. It isn't assigned to you: help with ` +
          "what they asked, and leave the rest to the assignee.",
  };
}

/**
 * Open incidents assigned to this agent whose newest comment is a person's, written after the agent last
 * worked on the incident: a comment that arrived while a run was already waiting (one queued run per agent).
 */
export async function unansweredIncidentComments(db: Database, agentId: string) {
  const open = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.assignedAgentId, agentId), notInArray(incidents.status, ["resolved", "closed"])));
  const out: { inc: typeof incidents.$inferSelect; comment: typeof incidentComments.$inferSelect }[] = [];
  for (const inc of open) {
    const [latest] = await db.select().from(incidentComments).where(eq(incidentComments.incidentId, inc.id)).orderBy(desc(incidentComments.createdAt)).limit(1);
    if (!latest?.authorUserId) continue;
    const [since] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.triggerRef, inc.id), gt(agentRuns.startedAt, latest.createdAt)))
      .limit(1);
    if (!since) out.push({ inc, comment: latest });
  }
  return out;
}

/** Turns domain events into agent runs. Tasks reference tickets by id; the agent reads them with its tools. */
export async function handleEvent(db: Database, boss: PgBoss, event: StoredEvent, opts: { homeAssistant?: HaCaller; log?: (msg: string, extra?: Record<string, unknown>) => void } = {}): Promise<void> {
  const p = event.payload as Record<string, string | undefined>;
  switch (event.type) {
    case "incident.created": {
      // Phone notifications through Home Assistant. Not awaited: a slow phone push mustn't hold up
      // other events, and a notification that arrives much later is worse than none, so it isn't retried.
      if (opts.homeAssistant && p.incidentId) {
        const call = opts.homeAssistant;
        void notifyIncident(db, call, p.incidentId).catch((err) => opts.log?.("home assistant notification failed", { error: (err as Error).message }));
      }
      return;
    }
    case "incident.assigned": {
      if (!p.agentId || !p.incidentId) return;
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, p.incidentId));
      if (!inc || inc.assignedAgentId !== p.agentId || inc.status === "resolved" || inc.status === "closed") return;
      await enqueueRun(boss, {
        agentId: p.agentId,
        trigger: "ticket",
        triggerRef: inc.id,
        requestedByUserId: inc.raisedByUserId ?? undefined,
        task:
          `You have been assigned incident ${incidentRef(inc.number)} (${inc.priority}), id ${inc.id}. Read it with incident_get, ` +
          "investigate, keep it updated with comments, and resolve it once the fix is verified. If fixing it needs a change " +
          "to a system, raise a change request linked to the incident.",
      });
      return;
    }
    case "incident.commented": {
      if (!p.incidentId || !p.commentId) return;
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, p.incidentId));
      const [comment] = await db.select().from(incidentComments).where(eq(incidentComments.id, p.commentId));
      if (!inc || !comment || inc.status === "closed") return;
      for (const agentId of await activeAgents(db, [inc.assignedAgentId, ...agentMentions(comment.mentions)])) {
        await enqueueRun(boss, await commentRun(db, inc, comment, agentId));
      }
      return;
    }
    case "change.commented": {
      if (!p.changeId || !p.noteId) return;
      const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, p.changeId));
      const [note] = await db.select().from(changeNotes).where(eq(changeNotes.id, p.noteId));
      if (!cr || !note) return;
      const finished = ["succeeded", "rolled_back", "cancelled", "rejected"].includes(cr.status);
      const who = await actorName(db, { type: "user", id: note.authorUserId });
      const said = `\n\n"${note.body.slice(0, 2000)}"\n\n`;
      const ref = `change ${changeRef(cr.number)} (id ${cr.id})`;
      for (const agentId of await activeAgents(db, [finished ? null : cr.requestedByAgentId, ...agentMentions(note.mentions)])) {
        await enqueueRun(boss, {
          agentId,
          trigger: "event",
          triggerRef: cr.id,
          requestedByUserId: note.authorUserId ?? undefined,
          task:
            agentId === cr.requestedByAgentId && !finished
              ? `${who} commented on ${ref}, which you're carrying out:${said}Read the change with change_get, then reply with ` +
                "change_comment: answer their question, or say what you'll do."
              : `${who} mentioned you in a comment on ${ref}:${said}Read the change with change_get, then reply with change_comment.`,
        });
      }
      return;
    }
    case "change.approved":
    case "change.rejected":
    case "change.access_granted": {
      if (!p.changeId) return;
      const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, p.changeId));
      if (!cr?.requestedByAgentId) return;
      const ref = changeRef(cr.number);
      const task = cr.accessGrant
        ? event.type === "change.rejected"
          ? `Your access request ${ref} was turned down. Read why with change_get, and carry on without that access (or tell whoever asked).`
          : `Your access request ${ref} was approved: you now have the access you asked for. Read it with change_get, then carry on ` +
            "with the work you needed it for (check the linked incident, if any)."
        : event.type === "change.approved"
          ? `Change ${ref} (id ${cr.id}) has been approved. Read it with change_get, run it with change_execute, carry out ` +
            "its verification plan, then call change_complete (or change_rollback if verification fails). Update the linked incident."
          : `Change ${ref} (id ${cr.id}) was rejected. Read the reason with change_get and update the linked incident; ` +
            "do not attempt the change another way.";
      await enqueueRun(boss, { agentId: cr.requestedByAgentId, trigger: "event", triggerRef: cr.id, task, requestedByUserId: cr.requestedByUserId ?? undefined });
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

  const lib = cfg.libraryDir ? await loadLibrary(cfg.libraryDir) : null;
  const welcome = cfg.libraryDir ? await readFile(join(cfg.libraryDir, "docs", "welcome.md"), "utf8").catch(() => null) : null;
  if (lib) {
    for (const org of await db.select({ id: orgs.id }).from(orgs)) {
      await syncBuiltInSkills(db, org.id, lib.skills.values());
      const added = await ensureCoreSkills(db, org.id);
      if (added) log("core skills given", { orgId: org.id, added });
    }
    log("library synced", { skills: lib.skills.size, templates: lib.templates.size });
  }
  // Every install has a Moss, the expert on MOSS itself, once there is a model to run it on.
  const mossTemplate = lib?.templates.get(MOSS_TEMPLATE);
  const hireMoss = async () => {
    for (const org of await db.select({ id: orgs.id }).from(orgs)) {
      const id = await ensureMoss(db, org.id, mossTemplate);
      if (id) log("hired Moss", { orgId: org.id, agentId: id });
    }
  };

  await ensureQueues(boss);

  await boss.work<RunInput>(RUN_QUEUE, { localConcurrency: 4 }, async ([job]) => {
    if (!job) return;
    let input = job.data;
    // A chat run answers the conversation as it stands when the run starts.
    const chat = input.trigger === "chat" && input.triggerRef ? await chatSnapshot(db, input.triggerRef, input.agentId) : undefined;
    if (chat === null) return; // already answered
    if (chat) input = { ...input, task: chat.task, requestedByUserId: chat.askerId ?? input.requestedByUserId };
    log("run started", { agentId: input.agentId, trigger: input.trigger });
    const outcome = await runAgent({ db, gate: cfg.gate, providerFor: cfg.providerFor, claudeCode: cfg.claudeCode }, input);
    log("run finished", { agentId: input.agentId, runId: outcome.runId, status: outcome.status });
    if (chat) await recordChatReply(db, input.triggerRef!, input.agentId, outcome, chat.cutoff);
    // Messages sent while the agent was busy (one run per agent at a time): answer them now.
    for (const conversationId of await unansweredConversations(db, input.agentId)) {
      await enqueueRun(boss, { agentId: input.agentId, trigger: "chat", triggerRef: conversationId, task: "Reply in chat" });
    }
    // Likewise incident comments that came in while a run was already queued.
    for (const { inc, comment } of await unansweredIncidentComments(db, input.agentId)) {
      await enqueueRun(boss, await commentRun(db, inc, comment, input.agentId));
    }
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
      await hireMoss();
      // Agents hired since the last sync get the core skills too (hiring adds them; this is the backstop).
      for (const org of await db.select({ id: orgs.id }).from(orgs)) {
        await ensureCoreSkills(db, org.id);
        // Everyone gets Moss's welcome once (new installs, new people, and existing people after an upgrade).
        if (welcome) {
          const n = await welcomeFromMoss(db, org.id, welcome);
          if (n) log("Moss welcomed", { orgId: org.id, people: n });
        }
      }
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
      await dispatchEvents(db, (e) => handleEvent(db, boss, e, { homeAssistant: cfg.homeAssistant, log }), 50);
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

  let haRunning = false;
  const homeAssistantTick = async () => {
    if (haRunning || !cfg.homeAssistant) return;
    haRunning = true;
    try {
      await runHomeAssistantTick(db, cfg.homeAssistant, { log });
    } catch (err) {
      log("home assistant module failed", { error: (err as Error).message });
    } finally {
      haRunning = false;
    }
  };
  const haTimer = setInterval(homeAssistantTick, cfg.homeAssistantIntervalMs ?? 60_000);
  return {
    stop: async () => {
      clearInterval(timer);
      clearInterval(eventTimer);
      clearInterval(monitorTimer);
      clearInterval(pruneTimer);
      clearInterval(haTimer);
      await boss.stop({ graceful: true });
    },
  };
}

export function httpGate(url: string, token: string) {
  return new HttpGateClient(url, token);
}
