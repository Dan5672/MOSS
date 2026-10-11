// Chat: direct messages and channels between people and agents. Agents answer when they're DMed, or
// @mentioned in a channel, and only when a person wrote the message: an agent's own messages never set
// another agent off, so agents can't talk each other into a loop.
import { agents, conversationMembers, conversationMessages, conversationReads, conversations, users, type Database } from "@moss/db";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { mentionables, notifyMentioned, parseMentions, type Mention } from "./mentions.js";

export type Member = { type: "user" | "agent"; id: string };
export class ChatError extends Error {}

/** A DM's identity: its two members, sorted. One DM per pair. */
export const dmKey = (a: Member, b: Member) => [a, b].map((m) => `${m.type === "agent" ? "a" : "u"}:${m.id}`).sort().join("|");

const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

async function assertMember(db: Pick<Database, "select">, conversationId: string, userId: string) {
  const [m] = await db.select({ id: conversationMembers.id }).from(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
  if (!m) throw new ChatError("You're not in this conversation");
}

async function assertInOrg(db: Pick<Database, "select">, orgId: string, m: Member) {
  const table = m.type === "agent" ? agents : users;
  const [row] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, m.id), eq(table.orgId, orgId)));
  if (!row) throw new ChatError(m.type === "agent" ? "Agent not found" : "Person not found");
}

const memberValues = (conversationId: string, m: Member) => ({ conversationId, userId: m.type === "user" ? m.id : null, agentId: m.type === "agent" ? m.id : null });

/** The DM between a person and another person or an agent: found, or started. */
export async function openDm(db: Database, orgId: string, userId: string, other: Member): Promise<string> {
  const me: Member = { type: "user", id: userId };
  if (other.type === "user" && other.id === userId) throw new ChatError("That's you");
  await assertInOrg(db, orgId, other);
  const key = dmKey(me, other);
  const [existing] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.orgId, orgId), eq(conversations.dmKey, key)));
  if (existing) return existing.id;
  return db.transaction(async (tx) => {
    const [conv] = await tx.insert(conversations).values({ orgId, kind: "dm", dmKey: key, createdByUserId: userId }).onConflictDoNothing().returning({ id: conversations.id });
    if (!conv) return (await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.orgId, orgId), eq(conversations.dmKey, key))))[0]!.id;
    await tx.insert(conversationMembers).values([memberValues(conv.id, me), memberValues(conv.id, other)]);
    return conv.id;
  });
}

/** A new channel, with its creator and any other members. */
export async function createChannel(db: Database, orgId: string, userId: string, input: { name: string; topic?: string; members?: Member[] }): Promise<string> {
  const name = input.name.trim().replace(/^#/, "").toLowerCase();
  if (!CHANNEL_NAME.test(name)) throw new ChatError("A channel name is lowercase letters, digits and dashes, e.g. network");
  const [taken] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.orgId, orgId), eq(conversations.name, name)));
  if (taken) throw new ChatError(`#${name} already exists`);
  for (const m of input.members ?? []) await assertInOrg(db, orgId, m);
  return db.transaction(async (tx) => {
    const [conv] = await tx.insert(conversations).values({ orgId, kind: "channel", name, topic: input.topic?.trim() || null, createdByUserId: userId }).returning({ id: conversations.id });
    const members = [{ type: "user" as const, id: userId }, ...(input.members ?? []).filter((m) => !(m.type === "user" && m.id === userId))];
    await tx.insert(conversationMembers).values(members.map((m) => memberValues(conv!.id, m))).onConflictDoNothing();
    return conv!.id;
  });
}

/** Adds a person or an agent to a channel (anyone in it can). */
export async function addToChannel(db: Database, orgId: string, conversationId: string, userId: string, member: Member) {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv || conv.kind !== "channel") throw new ChatError("Only channels have members added");
  await assertMember(db, conversationId, userId);
  await assertInOrg(db, orgId, member);
  await db.insert(conversationMembers).values(memberValues(conversationId, member)).onConflictDoNothing();
}

export const GENERAL_CHANNEL = "general";

/**
 * The company-wide channel, #general: created on first use, and everyone who can sign in is in it.
 * People can't leave it. Agents join when they're @mentioned there, like any channel.
 */
export async function ensureGeneralChannel(db: Database, orgId: string): Promise<string> {
  let [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.orgId, orgId), eq(conversations.name, GENERAL_CHANNEL)));
  if (!conv) {
    [conv] = await db
      .insert(conversations)
      .values({ orgId, kind: "channel", name: GENERAL_CHANNEL, topic: "Everyone, company-wide. @mention an agent to ask it something." })
      .onConflictDoNothing()
      .returning({ id: conversations.id });
    conv ??= (await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.orgId, orgId), eq(conversations.name, GENERAL_CHANNEL))))[0]!;
  }
  const people = await db.select({ id: users.id }).from(users).where(eq(users.orgId, orgId));
  if (people.length) {
    await db
      .insert(conversationMembers)
      .values(people.map((u) => memberValues(conv!.id, { type: "user", id: u.id })))
      .onConflictDoNothing();
  }
  return conv.id;
}

export async function leaveChannel(db: Database, orgId: string, conversationId: string, userId: string) {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv || conv.kind !== "channel") throw new ChatError("You can only leave a channel");
  if (conv.name === GENERAL_CHANNEL) throw new ChatError("Everyone stays in #general");
  await db.delete(conversationMembers).where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)));
}

export interface PostResult {
  messageId: string;
  /** Agents that should answer: the agent in a DM, or agents @mentioned in a channel. Only for people's messages. */
  agentsToAnswer: string[];
}

/** Posts a message. Agents @mentioned in a channel join it; people mentioned are notified. */
export async function postMessage(db: Database, orgId: string, conversationId: string, author: Member, body: string): Promise<PostResult> {
  const text = body.trim();
  if (!text) throw new ChatError("Write a message");
  if (text.length > 8000) throw new ChatError("That message is too long");
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv || conv.archived) throw new ChatError("Conversation not found");
  const members = await db.select().from(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
  const isMember = members.some((m) => (author.type === "user" ? m.userId === author.id : m.agentId === author.id));
  if (!isMember) throw new ChatError(author.type === "agent" ? "The agent isn't in this conversation" : "You're not in this conversation");

  const everyone = text.includes("@") ? await mentionables(db, orgId) : [];
  const mentions: Mention[] = everyone.length ? parseMentions(text, everyone) : [];
  const authorName = everyone.find((p) => p.id === author.id)?.name ?? (author.type === "agent" ? "An agent" : "Someone");
  const mentionedAgents = mentions.filter((m) => m.type === "agent").map((m) => m.id);

  return db.transaction(async (tx) => {
    const [msg] = await tx
      .insert(conversationMessages)
      .values({ conversationId, authorUserId: author.type === "user" ? author.id : null, authorAgentId: author.type === "agent" ? author.id : null, body: text, mentions })
      .returning({ id: conversationMessages.id, createdAt: conversationMessages.createdAt });
    await tx.update(conversations).set({ updatedAt: msg!.createdAt }).where(eq(conversations.id, conversationId));
    if (author.type === "user") {
      await tx
        .insert(conversationReads)
        .values({ conversationId, userId: author.id, lastReadAt: msg!.createdAt })
        .onConflictDoUpdate({ target: [conversationReads.conversationId, conversationReads.userId], set: { lastReadAt: msg!.createdAt } });
    }
    // Mentioning an agent in a channel brings it in, so it can see the conversation and answer.
    if (conv.kind === "channel" && mentionedAgents.length) {
      await tx.insert(conversationMembers).values(mentionedAgents.map((id) => memberValues(conversationId, { type: "agent", id }))).onConflictDoNothing();
    }
    const where = conv.kind === "channel" ? `#${conv.name}` : "a direct message";
    await notifyMentioned(tx, orgId, mentions, { ...author, name: authorName }, { ref: where, link: `/chat/${conversationId}`, body: text });
    let agentsToAnswer: string[] = [];
    if (author.type === "user") {
      agentsToAnswer = conv.kind === "dm" ? members.filter((m) => m.agentId).map((m) => m.agentId!) : mentionedAgents;
    }
    return { messageId: msg!.id, agentsToAnswer };
  });
}

export async function markRead(db: Database, conversationId: string, userId: string, at = new Date()) {
  await db
    .insert(conversationReads)
    .values({ conversationId, userId, lastReadAt: at })
    .onConflictDoUpdate({ target: [conversationReads.conversationId, conversationReads.userId], set: { lastReadAt: at } });
}

export interface ConversationSummary {
  id: string;
  kind: "dm" | "channel";
  /** "#network", or the other member's name for a DM. */
  title: string;
  /** For a DM with an agent: the agent. */
  agentId: string | null;
  unread: number;
  updatedAt: Date;
}

/** A person's conversations, most recent first, with unread counts. */
export async function listConversations(db: Pick<Database, "select">, orgId: string, userId: string): Promise<ConversationSummary[]> {
  const rows = await db
    .select({ conv: conversations, lastReadAt: conversationReads.lastReadAt })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .leftJoin(conversationReads, and(eq(conversationReads.conversationId, conversations.id), eq(conversationReads.userId, userId)))
    .where(and(eq(conversationMembers.userId, userId), eq(conversations.orgId, orgId), eq(conversations.archived, false)))
    .orderBy(desc(conversations.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.conv.id);
  const [others, unread] = await Promise.all([
    db
      .select({ conversationId: conversationMembers.conversationId, agentId: conversationMembers.agentId, agentName: agents.name, userName: users.displayName })
      .from(conversationMembers)
      .leftJoin(agents, eq(agents.id, conversationMembers.agentId))
      .leftJoin(users, eq(users.id, conversationMembers.userId))
      .where(and(inArray(conversationMembers.conversationId, ids), or(isNull(conversationMembers.userId), ne(conversationMembers.userId, userId)))),
    db
      .select({ conversationId: conversationMessages.conversationId, n: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .leftJoin(conversationReads, and(eq(conversationReads.conversationId, conversationMessages.conversationId), eq(conversationReads.userId, userId)))
      .where(
        and(
          inArray(conversationMessages.conversationId, ids),
          or(isNull(conversationMessages.authorUserId), ne(conversationMessages.authorUserId, userId)),
          or(isNull(conversationReads.lastReadAt), gt(conversationMessages.createdAt, conversationReads.lastReadAt)),
        ),
      )
      .groupBy(conversationMessages.conversationId),
  ]);
  return rows.map(({ conv }) => {
    const other = others.find((o) => o.conversationId === conv.id);
    return {
      id: conv.id,
      kind: conv.kind,
      title: conv.kind === "channel" ? `#${conv.name}` : (other?.agentName ?? other?.userName ?? "Just you"),
      agentId: conv.kind === "dm" ? (other?.agentId ?? null) : null,
      unread: unread.find((u) => u.conversationId === conv.id)?.n ?? 0,
      updatedAt: conv.updatedAt,
    };
  });
}

/** A conversation for someone in it: its members and latest messages (oldest first). */
export async function getConversation(db: Pick<Database, "select">, orgId: string, conversationId: string, userId: string, limit = 200) {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  if (!conv) return null;
  await assertMember(db, conversationId, userId);
  const [members, messages] = await Promise.all([
    db
      .select({
        userId: conversationMembers.userId,
        agentId: conversationMembers.agentId,
        agentName: agents.name,
        agentTitle: agents.title,
        agentStatus: agents.status,
        templateKey: agents.templateKey,
        mascot: agents.mascot,
        mascotGlow: agents.mascotGlow,
        userName: users.displayName,
      })
      .from(conversationMembers)
      .leftJoin(agents, eq(agents.id, conversationMembers.agentId))
      .leftJoin(users, eq(users.id, conversationMembers.userId))
      .where(eq(conversationMembers.conversationId, conversationId)),
    db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)).orderBy(desc(conversationMessages.createdAt)).limit(limit),
  ]);
  return { ...conv, members, messages: messages.reverse() };
}
