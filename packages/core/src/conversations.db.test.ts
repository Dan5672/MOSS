// Chat conversations against Postgres: DMs, channels, membership, unread counts and mention notifications.
import { agents, notifications, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToChannel, createChannel, getConversation, listConversations, markRead, openDm, postMessage } from "./services/conversations.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe.skipIf(!TEST_DATABASE_URL)("chat (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ann: string;
  let bob: string;
  let nina: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_chat"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "ann@h.test", ownerName: "Ann", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    ann = boot.owner.id;
    bob = (await db.insert(users).values({ orgId, email: "bob@h.test", displayName: "Bob", passwordHash: "x" }).returning())[0]!.id;
    nina = (await db.insert(agents).values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x" }).returning())[0]!.id;
  });
  afterAll(() => close?.());

  it("one DM per pair, whoever starts it", async () => {
    const a = await openDm(db, orgId, ann, { type: "user", id: bob });
    expect(await openDm(db, orgId, bob, { type: "user", id: ann })).toBe(a);
    await expect(openDm(db, orgId, ann, { type: "user", id: ann })).rejects.toThrow(/That's you/);
  });

  it("unread counts, read markers, and only members can read or post", async () => {
    const dm = await openDm(db, orgId, ann, { type: "user", id: bob });
    await postMessage(db, orgId, dm, { type: "user", id: ann }, "Lunch?");
    await postMessage(db, orgId, dm, { type: "user", id: ann }, "Or coffee?");
    const bobs = await listConversations(db, orgId, bob);
    expect(bobs.find((c) => c.id === dm)).toMatchObject({ title: "Ann", unread: 2 });
    expect((await listConversations(db, orgId, ann)).find((c) => c.id === dm)).toMatchObject({ title: "Bob", unread: 0 });
    await markRead(db, dm, bob);
    expect((await listConversations(db, orgId, bob)).find((c) => c.id === dm)!.unread).toBe(0);

    const channel = await createChannel(db, orgId, ann, { name: "#Network" });
    await expect(getConversation(db, orgId, channel, bob)).rejects.toThrow(/not in this conversation/);
    await expect(postMessage(db, orgId, channel, { type: "user", id: bob }, "hi")).rejects.toThrow(/not in this conversation/);
    await addToChannel(db, orgId, channel, ann, { type: "user", id: bob });
    expect((await getConversation(db, orgId, channel, bob))!.name).toBe("network");
    await expect(createChannel(db, orgId, ann, { name: "network" })).rejects.toThrow(/already exists/);
    await expect(createChannel(db, orgId, ann, { name: "Bad Name!" })).rejects.toThrow(/lowercase/);
  });

  it("a DM with an agent asks it to answer; a channel only when mentioned, which also adds it; people mentioned are notified", async () => {
    const dm = await openDm(db, orgId, ann, { type: "agent", id: nina });
    expect((await postMessage(db, orgId, dm, { type: "user", id: ann }, "Is the Wi-Fi OK?")).agentsToAnswer).toEqual([nina]);

    const channel = await createChannel(db, orgId, ann, { name: "wifi", members: [{ type: "user", id: bob }] });
    expect((await postMessage(db, orgId, channel, { type: "user", id: ann }, "anyone?")).agentsToAnswer).toEqual([]);
    expect((await postMessage(db, orgId, channel, { type: "user", id: ann }, "@Nina and @Bob, the AP keeps dropping")).agentsToAnswer).toEqual([nina]);
    expect((await getConversation(db, orgId, channel, ann))!.members.some((m) => m.agentId === nina)).toBe(true);
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, bob));
    expect(n).toMatchObject({ kind: "mention", title: "Ann mentioned you on #wifi", link: `/chat/${channel}` });
  });
});
