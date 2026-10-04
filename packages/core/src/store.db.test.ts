// Integration tests against Postgres. Run with MOSS_TEST_DATABASE_URL set.
import { agents, auditLog, budgets, models, providers, tokenUsage, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "./auth/password.js";
import { writeAudit, verifyAuditLog } from "./store/audit-store.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { getBudgetStatus } from "./store/budget-store.js";
import { getSetting, setSetting } from "./store/settings-store.js";

describe.skipIf(!TEST_DATABASE_URL)("core stores (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_stores"));
    const { org } = await bootstrapOrg(db, {
      orgName: "Home Lab",
      ownerEmail: "Owner@Example.com",
      ownerName: "Owner",
      ownerPassword: "a-long-test-password",
    });
    orgId = org.id;
  });
  afterAll(() => close?.());

  it("bootstraps once, with a hashed owner password", async () => {
    const owner = await db.query.users.findFirst();
    expect(owner?.email).toBe("owner@example.com");
    expect(await verifyPassword("a-long-test-password", owner!.passwordHash!)).toBe(true);
    await expect(
      bootstrapOrg(db, { orgName: "x", ownerEmail: "a@b.c", ownerName: "x", ownerPassword: "a-long-test-password" }),
    ).rejects.toThrow(/already set up/);
  });

  it("keeps the audit chain intact under concurrent writers", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeAudit(db, { orgId, actorType: "agent", actorId: `agent-${i % 3}`, action: "tool.call", details: { i } }),
      ),
    );
    expect(await verifyAuditLog(db, orgId)).toBeNull();
  });

  it("detects tampering in the stored audit log", async () => {
    const [victim] = await db.select().from(auditLog).where(eq(auditLog.action, "tool.call")).limit(1);
    await db.execute(sql`update audit_log set details = '{"i": 999}' where id = ${victim!.id}`);
    expect(await verifyAuditLog(db, orgId)).toBe(victim!.id);
  });

  it("stores settings with defaults", async () => {
    expect(await getSetting(db, orgId, "agents.kill_switch")).toBe(false);
    await setSetting(db, orgId, "agents.kill_switch", true);
    expect(await getSetting(db, orgId, "agents.kill_switch")).toBe(true);
  });

  it("computes per-agent and global budget status", async () => {
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db
      .insert(models)
      .values({ orgId, providerId: provider!.id, modelId: "llama", displayName: "Llama" })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x", modelId: model!.id })
      .returning();

    await db.insert(budgets).values([
      { orgId, agentId: agent!.id, period: "day", unit: "tokens", softLimit: "800", hardLimit: "1000" },
      { orgId, agentId: null, period: "month", unit: "usd", hardLimit: "5" },
    ]);
    const usage = { orgId, agentId: agent!.id, modelId: model!.id };
    await db.insert(tokenUsage).values({ ...usage, inputTokens: 500, outputTokens: 350, costUsd: "1.5" });

    let status = await getBudgetStatus(db, orgId, agent!.id);
    expect(status).toMatchObject({ overSoft: true, overHard: false });

    await db.insert(tokenUsage).values({ ...usage, inputTokens: 100, outputTokens: 100, costUsd: "0.1" });
    status = await getBudgetStatus(db, orgId, agent!.id);
    expect(status.overHard).toBe(true);
    expect(status.checks.find((c) => c.scope === "global")?.spent).toBeCloseTo(1.6);

    // Evaluated tomorrow, today's usage no longer counts against the daily budget.
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect((await getBudgetStatus(db, orgId, agent!.id, tomorrow)).checks.find((c) => c.period === "day")?.spent).toBe(0);
  });
});
