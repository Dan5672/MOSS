// Worker against Postgres + pg-boss with a scripted LLM and a fake gate. Run with MOSS_TEST_DATABASE_URL set.
import { hireFromTemplate, loadLibrary, pauseAgent, type GateClient } from "@moss/agent";
import { bootstrapOrg } from "@moss/core";
import { agentRuns, models, providers, skills, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { MockAdapter } from "@moss/llm";
import { eq } from "drizzle-orm";
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
    });
  });
  afterAll(async () => {
    await worker?.stop();
    await close?.();
  });

  it("syncs built-in skills on startup", async () => {
    const rows = await db.select().from(skills).where(eq(skills.orgId, actor.orgId));
    expect(rows.map((s) => s.key).sort()).toEqual(["asset-inventory", "network-discovery", "security-baseline", "service-desk", "service-health"]);
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
});
