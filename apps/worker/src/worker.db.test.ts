// Worker against Postgres + pg-boss with a scripted LLM and a fake gate. Run with MOSS_TEST_DATABASE_URL set.
import { chatSnapshot, hireCustom, hireFromTemplate, loadLibrary, pauseAgent, type GateClient } from "@moss/agent";
import { approveChange, bootstrapOrg, createChangeRequest, createIncident, createMonitor, type CheckResult } from "@moss/core";
import { agentRuns, chatMessages, chatThreads, incidentComments, incidents, models, monitors, providers, skills, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { MockAdapter } from "@moss/llm";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueRun, SCHEDULE_QUEUE, startWorker, syncSchedules } from "./worker.js";

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
      "home-dns-actions",
      "homelab-integrations",
      "incident-management",
      "monitoring-response",
      "network-discovery",
      "network-insight",
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

  it("chat: answers a message with a run, skips answered threads, and catches up on messages sent while busy", async () => {
    const wren = await hireCustom(db, actor, { name: "Wren", title: "Backup Admin", systemPrompt: "You look after backups and nothing else.", skills: ["service-health"], modelId });
    const [thread] = await db.insert(chatThreads).values({ orgId: actor.orgId, agentId: wren.id, userId: actor.userId }).returning();
    const say = async (content: string) => (await db.insert(chatMessages).values({ threadId: thread!.id, role: "user", content }).returning())[0]!;
    const replies = () => db.select().from(chatMessages).where(and(eq(chatMessages.threadId, thread!.id), eq(chatMessages.role, "agent")));

    const question = await say("Is the NAS backed up?");
    const snapshot = await chatSnapshot(db, thread!.id);
    expect(snapshot!.task).toContain("O: Is the NAS backed up?");

    await enqueueRun(boss, { agentId: wren.id, trigger: "chat", triggerRef: thread!.id, task: "Is the NAS backed up?" });
    const [reply] = await waitFor(async () => ((await replies()).length === 1 ? replies() : undefined));
    expect(reply).toMatchObject({ content: "All good.", status: "succeeded" });
    expect(reply!.runId).toBeTruthy();
    expect(reply!.createdAt.getTime()).toBeGreaterThan(question.createdAt.getTime());
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, reply!.runId!));
    expect(run).toMatchObject({ trigger: "chat", triggerRef: thread!.id });

    // Already answered: a duplicate job does nothing.
    expect(await chatSnapshot(db, thread!.id)).toBeNull();

    // A message that arrives while the agent is busy with other work is answered when that run ends.
    await say("And the router config?");
    await enqueueRun(boss, { agentId: wren.id, trigger: "manual", task: "Check the backups." });
    await waitFor(async () => ((await replies()).length === 2 ? true : undefined));
    expect(await chatSnapshot(db, thread!.id)).toBeNull();
  });
});
