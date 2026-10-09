// Worker against Postgres + pg-boss with a scripted LLM and a fake gate. Run with MOSS_TEST_DATABASE_URL set.
import { chatSnapshot, unansweredConversations, hireCustom, hireFromTemplate, loadLibrary, pauseAgent, type GateClient } from "@moss/agent";
import { addChangeComment, addIncidentComment, createChannel, openDm, postMessage, approveChange, bootstrapOrg, createChangeRequest, createIncident, createMonitor, type CheckResult } from "@moss/core";
import { agentRuns, agents, conversationMessages, incidentComments, incidents, models, monitors, providers, skills, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { MockAdapter } from "@moss/llm";
import { and, desc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueRun, SCHEDULE_QUEUE, startWorker, syncSchedules, unansweredIncidentComments } from "./worker.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!TEST_DATABASE_URL)("worker (postgres + pg-boss)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let boss: PgBoss;
  let worker: { stop: () => Promise<unknown> };
  let actor: { orgId: string; userId: string };
  let modelId: string;
  const gate: GateClient = { listTools: async () => [], callTool: async () => ({ allowed: false, code: "x", reason: "x" }) };
  let checkResult: CheckResult = { ok: true, message: "ok" };
  const checked: string[] = [];

  beforeAll(async () => {
    let url: string;
    ({ db, close, url } = await createTestDb("worker"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    actor = { orgId: boot.org.id, userId: boot.owner.id };
    const [provider] = await db.insert(providers).values({ orgId: actor.orgId, kind: "ollama", name: "Local" }).returning();
    [{ id: modelId }] = await db.insert(models).values({ orgId: actor.orgId, providerId: provider!.id, modelId: "llama", displayName: "Llama" }).returning();

    boss = new PgBoss(url);
    await boss.start();
    // Clear queue state left over from a previous test run (pg-boss lives in its own schema).
    await boss.deleteAllJobs().catch(() => {});
    for (const s of await boss.getSchedules().catch(() => [])) await boss.unschedule(s.name, s.key);

    worker = await startWorker({
      db,
      boss,
      gate,
      providerFor: () => new MockAdapter([{ text: "All good." }]),
      libraryDir: LIBRARY_DIR,
      log: () => {},
      eventIntervalMs: 200,
      monitorIntervalMs: 200,
      checkMonitor: async (id) => {
        checked.push(id);
        return checkResult;
      },
    });
  });
  afterAll(async () => {
    await worker?.stop();
    await close?.();
  });

  it("syncs built-in skills on startup", async () => {
    const rows = await db.select().from(skills).where(eq(skills.orgId, actor.orgId));
    expect(rows.map((s) => s.key).sort()).toEqual([
      "asset-inventory",
      "change-management",
      "config-backups",
      "device-power",
      "home-assistant",
      "home-dns-actions",
      "homelab-integrations",
      "incident-management",
      "monitoring-response",
      "moss-expert",
      "network-discovery",
      "network-insight",
      "network-wiki",
      "security-baseline",
      "server-actions",
      "server-checks",
      "service-desk",
      "service-health",
      "team-memory",
      "unifi-actions",
    ]);
  });

  it("mirrors agent schedules into the queue and removes them when the agent is paused", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    const nina = await hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId });
    expect(await syncSchedules(db, boss)).toEqual({ added: 1, removed: 0 });
    expect(await syncSchedules(db, boss)).toEqual({ added: 0, removed: 0 });
    const [schedule] = await boss.getSchedules(SCHEDULE_QUEUE);
    expect(schedule).toMatchObject({ cron: "30 2 * * *" });

    await pauseAgent(db, actor, nina.id);
    expect(await syncSchedules(db, boss)).toEqual({ added: 0, removed: 1 });
  });

  it("runs queued jobs and records the run", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    const sam = await hireFromTemplate(db, actor, { template: lib.templates.get("systems-admin")!, modelId });
    expect(await enqueueRun(boss, { agentId: sam.id, task: "Check the servers", trigger: "manual" })).toBeTruthy();

    const run = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.agentId, sam.id));
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(run).toMatchObject({ trigger: "manual", summary: "All good." });
  });

  it("turns a fired schedule into a scheduled run", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    const hana = await hireFromTemplate(db, actor, { template: lib.templates.get("systems-admin")!, modelId, name: "Hana" });
    await syncSchedules(db, boss);
    const schedule = (await boss.getSchedules(SCHEDULE_QUEUE)).find((s) => s.data && (s.data as { scheduleId: string }).scheduleId);
    // Simulate the cron firing by sending the job the schedule would send.
    const sched = await db.query.agentSchedules.findFirst({ where: (t, { eq }) => eq(t.agentId, hana.id) });
    await boss.send(SCHEDULE_QUEUE, { scheduleId: sched!.id });
    expect(schedule).toBeDefined();

    const run = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.agentId, hana.id));
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(run).toMatchObject({ trigger: "schedule", triggerRef: sched!.id });
  });

  it("starts runs from events: incident assignment and change approval", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    const nina = await hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId, name: "Nina 2" });

    const inc = await createIncident(db, actor.orgId, { type: "break_fix", title: "Printer offline", assignedAgentId: nina.id }, { type: "user", id: actor.userId });
    const ticketRun = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, inc.id));
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(ticketRun).toMatchObject({ agentId: nina.id, trigger: "ticket" });

    const cr = await createChangeRequest(
      db,
      actor.orgId,
      {
        type: "normal",
        title: "Wake NAS",
        description: "d",
        rollbackPlan: "r",
        verificationPlan: "v",
        plannedCalls: [{ tool: "wake_on_lan", args: { mac: "aa:bb:cc:dd:ee:ff", broadcast: "192.168.1.255" } }],
      },
      { type: "agent", id: nina.id },
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, cr.id))).toHaveLength(0); // submitted: nothing to do yet

    await approveChange(db, actor.orgId, cr.id, actor.userId);
    const changeRun = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, cr.id));
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(changeRun).toMatchObject({ agentId: nina.id, trigger: "event" });

    // A person's comment gets an answer; the agent's own comment doesn't set off another run.
    const runsFor = async (ref: string) => (await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, ref))).length;
    await addIncidentComment(db, actor.orgId, inc.id, "Is it the toner again?", { type: "user", id: actor.userId });
    await waitFor(async () => ((await runsFor(inc.id)) === 2 ? true : undefined));
    const [answerRun] = await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, inc.id)).orderBy(desc(agentRuns.startedAt)).limit(1);
    expect(answerRun).toMatchObject({ agentId: nina.id, trigger: "ticket" });
    await addIncidentComment(db, actor.orgId, inc.id, "Checking the toner now.", { type: "agent", id: nina.id });
    await new Promise((r) => setTimeout(r, 800));
    expect(await runsFor(inc.id)).toBe(2);

    await addChangeComment(db, actor.orgId, cr.id, "Can this wait until tonight?", { type: "user", id: actor.userId });
    await waitFor(async () => ((await runsFor(cr.id)) === 2 ? true : undefined));

    // An @mentioned agent gets a task too, alongside the assignee.
    const pip = await hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId, name: "Pip" });
    await addIncidentComment(db, actor.orgId, inc.id, "@Pip can you check the switch port too?", { type: "user", id: actor.userId });
    const pipRun = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(and(eq(agentRuns.triggerRef, inc.id), eq(agentRuns.agentId, pip.id)));
      return r;
    });
    expect(pipRun).toMatchObject({ trigger: "ticket" });
    await waitFor(async () => ((await runsFor(inc.id)) === 4 ? true : undefined)); // Nina answers as well
  });

  it("monitors: a failing check raises an incident for the responder agent, and recovery hands it back", async () => {
    const lib = await loadLibrary(LIBRARY_DIR);
    const sam = await hireFromTemplate(db, actor, { template: lib.templates.get("systems-admin")!, modelId, name: "Sam M" });
    checkResult = { ok: false, message: "connect ECONNREFUSED 192.168.1.10:5000" };
    const m = await createMonitor(
      db,
      actor.orgId,
      { name: "NAS web", kind: "tcp", target: "192.168.1.10", config: { port: 5000 }, intervalSeconds: 30, failureThreshold: 1, recoveryThreshold: 1, responderAgentId: sam.id },
      { type: "user", id: actor.userId },
    );

    const inc = await waitFor(async () => (await db.select().from(incidents).where(eq(incidents.title, "NAS web is down")))[0]);
    expect(checked).toContain(m.id);
    expect(inc).toMatchObject({ assignedAgentId: sam.id, priority: "P3" });
    const ticketRun = await waitFor(async () => {
      const [r] = await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, inc.id));
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(ticketRun).toMatchObject({ agentId: sam.id, trigger: "ticket" });

    checkResult = { ok: true, latencyMs: 3, message: "Port 5000 open" };
    await db.update(monitors).set({ nextCheckAt: new Date() }).where(eq(monitors.id, m.id));
    await waitFor(async () => (await db.select().from(incidentComments).where(eq(incidentComments.incidentId, inc.id)))[0]);
    const runs = await waitFor(async () => {
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.triggerRef, inc.id));
      return rows.length === 2 && rows.every((r) => r.status === "succeeded") ? rows : undefined;
    });
    expect(runs.map((r) => r.trigger).sort()).toEqual(["event", "ticket"]);
  });

  it("chat: answers DMs and mentions with a run, skips what's answered, and catches up on messages sent while busy", async () => {
    const wren = await hireCustom(db, actor, { name: "Wren", title: "Backup Admin", systemPrompt: "You look after backups and nothing else.", skills: ["service-health"], modelId });
    const me = { type: "user" as const, id: actor.userId };
    const dm = await openDm(db, actor.orgId, actor.userId, { type: "agent", id: wren.id });
    const replies = (conversationId: string) =>
      db.select().from(conversationMessages).where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.authorAgentId, wren.id)));

    const posted = await postMessage(db, actor.orgId, dm, me, "Is the NAS backed up?");
    expect(posted.agentsToAnswer).toEqual([wren.id]);
    const snapshot = await chatSnapshot(db, dm, wren.id);
    expect(snapshot!.task).toContain("O: Is the NAS backed up?");

    await enqueueRun(boss, { agentId: wren.id, trigger: "chat", triggerRef: dm, task: "Reply in chat" });
    const [reply] = await waitFor(async () => ((await replies(dm)).length === 1 ? replies(dm) : undefined));
    expect(reply).toMatchObject({ body: "All good.", status: "succeeded" });
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, reply!.runId!));
    expect(run).toMatchObject({ trigger: "chat", triggerRef: dm });

    // Already answered: a duplicate job does nothing.
    expect(await chatSnapshot(db, dm, wren.id)).toBeNull();

    // A message that arrives while the agent is busy with other work is answered when that run ends.
    await postMessage(db, actor.orgId, dm, me, "And the router config?");
    await enqueueRun(boss, { agentId: wren.id, trigger: "manual", task: "Check the backups." });
    await waitFor(async () => ((await replies(dm)).length === 2 ? true : undefined));
    expect(await chatSnapshot(db, dm, wren.id)).toBeNull();

    // In a channel, only an @mention asks an agent; the mention brings it into the channel.
    const channel = await createChannel(db, actor.orgId, actor.userId, { name: "backups" });
    expect((await postMessage(db, actor.orgId, channel, me, "Morning all")).agentsToAnswer).toEqual([]);
    expect((await postMessage(db, actor.orgId, channel, me, "@Wren did last night's job finish?")).agentsToAnswer).toEqual([wren.id]);
    expect(await unansweredConversations(db, wren.id)).toEqual([channel]);
    expect((await chatSnapshot(db, channel, wren.id))!.task).toContain("#backups");
    // An agent's own message never asks anyone.
    expect((await postMessage(db, actor.orgId, channel, { type: "agent", id: wren.id }, "@Wren talking to myself")).agentsToAnswer).toEqual([]);
  });

  it("catches up on incident comments that came in while a run was already queued", async () => {
    const [ivy] = await db.insert(agents).values({ orgId: actor.orgId, name: "Ivy", title: "Security Admin", systemPrompt: "x", modelId, status: "paused" }).returning();
    const [inc] = await db.insert(incidents).values({ orgId: actor.orgId, type: "security", title: "Odd login", priority: "P2", assignedAgentId: ivy!.id }).returning();
    await db.insert(incidentComments).values({ incidentId: inc!.id, authorAgentId: ivy!.id, body: "Looking." });
    expect(await unansweredIncidentComments(db, ivy!.id)).toEqual([]); // the agent spoke last
    await new Promise((r) => setTimeout(r, 5));
    await db.insert(incidentComments).values({ incidentId: inc!.id, authorUserId: actor.userId, body: "Was it me?" });
    expect((await unansweredIncidentComments(db, ivy!.id)).map((x) => x.comment.body)).toEqual(["Was it me?"]);
    await db.insert(agentRuns).values({ orgId: actor.orgId, agentId: ivy!.id, trigger: "ticket", triggerRef: inc!.id });
    expect(await unansweredIncidentComments(db, ivy!.id)).toEqual([]); // worked on since
  });
});
