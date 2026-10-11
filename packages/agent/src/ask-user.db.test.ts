// ask_user against Postgres: who an agent asks, where the question goes, and the once-per-run limit.
import { bootstrapOrg } from "@moss/core";
import { agentRuns, agents, conversationMessages, notifications, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_TOOL_MAP } from "./platform-tools.js";

describe.skipIf(!TEST_DATABASE_URL)("ask_user (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let owner: string;
  let bob: string;
  let agentId: string;
  const ask = PLATFORM_TOOL_MAP.get("ask_user")!;
  const call = (runId: string, question: string) => ask.run({ db, orgId, agentId, runId, gate: {} as never }, { question }) as Promise<Record<string, unknown>>;
  const newRun = async (values: Partial<typeof agentRuns.$inferInsert> = {}) =>
    (await db.insert(agentRuns).values({ orgId, agentId, trigger: "manual", task: "Tidy the DHCP reservations", ...values }).returning())[0]!.id;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("agent_ask"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "Owner", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    owner = boot.owner.id;
    bob = (await db.insert(users).values({ orgId, email: "b@h.test", displayName: "Bob", passwordHash: "x" }).returning())[0]!.id;
    agentId = (await db.insert(agents).values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x" }).returning())[0]!.id;
  });
  afterAll(() => close?.());

  it("asks whoever gave the task, in a DM with the task as context, once per run", async () => {
    const runId = await newRun({ requestedByUserId: bob });
    expect(await call(runId, "Shall I reserve .50 for the TV, or .60?")).toMatchObject({ ok: true });
    const [msg] = await db.select().from(conversationMessages).where(eq(conversationMessages.runId, runId));
    expect(msg).toMatchObject({ authorAgentId: agentId });
    expect(msg!.body).toBe("Shall I reserve .50 for the TV, or .60?\n\n(I'm asking while working on: Tidy the DHCP reservations)");
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, bob));
    expect(n).toMatchObject({ kind: "agent.question", title: "Nina has a question for you" });
    expect(await call(runId, "And another thing?")).toMatchObject({ error: expect.stringContaining("already asked") });
  });

  it("with no requester, asks a manager; in a chat, asks in the reply instead", async () => {
    const runId = await newRun();
    expect(await call(runId, "Which VLAN for the cameras?")).toMatchObject({ ok: true });
    expect((await db.select().from(notifications).where(eq(notifications.userId, owner))).some((n) => n.kind === "agent.question")).toBe(true);
    expect(await call(await newRun({ trigger: "chat" }), "?")).toMatchObject({ error: expect.stringContaining("already in a chat") });
  });
});
