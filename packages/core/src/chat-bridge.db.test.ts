// Telegram and Discord: linking, chatting with agents, forwarded notifications and replies, and approvals.
import { agents, changeRequests, chatLinks, chatOutbox, conversationMessages, models, notifications, providers, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatApprovalBlocked, createLinkCode, handleButton, handleIncoming, queueChatMessages, wantsNotification, chatConfigSchema } from "./chat-bridge/chat.js";
import { createChangeRequest } from "./services/changes.js";
import { postMessage } from "./services/conversations.js";
import { saveModule } from "./services/modules.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe("what goes to the chat app", () => {
  it("follows the platform's settings", () => {
    const c = chatConfigSchema.parse({ minPriority: "P2" });
    expect(wantsNotification(c, { kind: "incident", title: "P1 INC-4: Internet down" })).toBe(true);
    expect(wantsNotification(c, { kind: "incident", title: "P3 INC-5: Printer" })).toBe(false);
    expect(wantsNotification({ ...c, monitors: false }, { kind: "monitor", title: "NAS recovered" })).toBe(false);
    expect(wantsNotification(c, { kind: "change", title: "CR-1 needs approval" })).toBe(true);
  });

  it("keeps risky changes for MOSS itself", () => {
    const base = { type: "normal" as const, risk: "medium" as const, plannedCalls: [], accessGrant: null };
    expect(chatApprovalBlocked(base)).toBeNull();
    expect(chatApprovalBlocked({ ...base, type: "emergency" })).toMatch(/Emergency/);
    expect(chatApprovalBlocked({ ...base, risk: "high" })).toMatch(/High-risk/);
    expect(chatApprovalBlocked({ ...base, accessGrant: { tools: ["x"] } as never })).toMatch(/Access/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("chat bridge (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let mossId: string;
  const tg = (text: string) => ({ orgId, platform: "telegram" as const, externalUserId: "tg-42", chatId: "42", username: "dana", text });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_chat_bridge"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "Dana", ownerPassword: "a-long-test-password" }));
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    const [moss] = await db.insert(agents).values({ orgId, name: "Moss", title: "MOSS expert", systemPrompt: "x", modelId: model!.id, templateKey: "moss" }).returning();
    await db.insert(agents).values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x", modelId: model!.id });
    mossId = moss!.id;
    await saveModule(db, orgId, "telegram", { enabled: true, config: { minPriority: "P2" } }, { type: "user", id: ownerId });
  });
  afterAll(() => close?.());

  it("links an account with a one-time code, and ignores accounts that aren't linked", async () => {
    expect((await handleIncoming(db, tg("hello"))).replies[0]).toMatch(/link your account/);
    expect((await handleIncoming(db, tg("/link WRONG123"))).replies[0]).toMatch(/didn't work/);
    const code = await createLinkCode(db, orgId, ownerId, "telegram");
    expect((await handleIncoming(db, tg(`/link ${code.toLowerCase()}`))).replies[0]).toMatch(/^Linked to Dana/);
    expect((await handleIncoming(db, tg(`/link ${code}`))).replies[0]).toMatch(/didn't work/); // used once
    const expired = await createLinkCode(db, orgId, ownerId, "telegram", new Date(Date.now() - 11 * 60_000));
    expect((await handleIncoming(db, { ...tg(`/link ${expired}`), externalUserId: "tg-99" })).replies[0]).toMatch(/didn't work/);
  });

  it("talks to Moss, or another agent, through the person's DM in MOSS", async () => {
    const res = await handleIncoming(db, tg("Is the NAS up?"));
    expect(res.run).toMatchObject({ agentId: mossId, userId: ownerId });
    const [msg] = await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, res.run!.conversationId));
    expect(msg).toMatchObject({ body: "Is the NAS up?", authorUserId: ownerId });
    expect((await handleIncoming(db, tg("/agents"))).replies[0]).toMatch(/• Moss \(MOSS expert\)\n• Nina/);
    expect((await handleIncoming(db, tg("/agent nina"))).replies[0]).toBe("You're now talking to Nina.");
    expect((await handleIncoming(db, tg("hi"))).run!.agentId).not.toBe(mossId);

    // The agent's reply comes back; their own message doesn't.
    await postMessage(db, orgId, res.run!.conversationId, { type: "agent", id: mossId }, "Yes, the NAS is up.");
    await queueChatMessages(db);
    const out = await db.select().from(chatOutbox);
    expect(out.map((o) => o.text)).toContain("Moss: Yes, the NAS is up.");
    expect(out.every((o) => o.chatId === "42")).toBe(true);
    await queueChatMessages(db);
    expect(await db.select().from(chatOutbox)).toHaveLength(out.length); // nothing twice
  });

  it("forwards notifications by the settings, with Approve and Reject on changes, and approves as the person", async () => {
    await db.delete(chatOutbox);
    const now = new Date(Date.now() + 1000);
    await db.insert(notifications).values([
      { orgId, userId: ownerId, kind: "incident", title: "P1 INC-7: Internet down", link: "/incidents/x", createdAt: now },
      { orgId, userId: ownerId, kind: "incident", title: "P4 INC-8: Label printer", createdAt: now },
    ]);
    const change = await createChangeRequest(
      db,
      orgId,
      { type: "normal", title: "Restart the printer", description: "It's stuck", rollbackPlan: "none", verificationPlan: "print a page", manual: true },
      { type: "user", id: ownerId },
    );
    await queueChatMessages(db, new Date(Date.now() + 5000));
    const out = await db.select().from(chatOutbox);
    expect(out.map((o) => o.text.split("\n")[0]).sort()).toEqual([`CR-${change.number} needs approval: Restart the printer`, "P1 INC-7: Internet down"]);
    expect(out.find((o) => o.text.startsWith("CR-"))!.buttons).toEqual([
      { label: "Approve", data: `approve:${change.id}` },
      { label: "Reject", data: `reject:${change.id}` },
    ]);

    expect(await handleButton(db, { orgId, platform: "telegram", externalUserId: "tg-99", data: `approve:${change.id}` })).toEqual({ text: "Link your MOSS account first." });
    expect(await handleButton(db, { orgId, platform: "telegram", externalUserId: "tg-42", data: `approve:${change.id}` })).toEqual({ text: "Approved by Dana." });
    expect((await db.select().from(changeRequests).where(eq(changeRequests.id, change.id)))[0]!.status).toBe("approved");
    expect((await handleButton(db, { orgId, platform: "telegram", externalUserId: "tg-42", data: `reject:${change.id}` })).text).toMatch(/approved already/);
  });

  it("unlinks", async () => {
    expect((await handleIncoming(db, tg("/unlink"))).replies[0]).toMatch(/Disconnected/);
    expect(await db.select().from(chatLinks)).toHaveLength(0);
  });
});
