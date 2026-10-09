// Chat with agents, in DMs and channels. A person's message to an agent (a DM, or an @mention in a channel)
// starts a run with trigger "chat" and triggerRef = the conversation id. The worker builds the run's task
// from the conversation, and the run's final summary is posted as the agent's reply. Chat is just another
// way to start a run, so the policy gate, budgets, step limits and audit all apply as they do elsewhere.
import { agents, conversationMembers, conversationMessages, conversations, users, type Database } from "@moss/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RunOutcome } from "./runtime.js";

/** How much of the conversation each reply sees. */
const HISTORY_MESSAGES = 20;

export interface ChatSnapshot {
  /** The run's task: the recent conversation, ending with what needs answering. */
  task: string;
  /** Time of the newest message the task includes. The reply is stored just after it, so anything
   * sent while the agent works sorts after the reply and is answered by a follow-up run. */
  cutoff: Date;
}

type Message = typeof conversationMessages.$inferSelect;

/** Whether a message is for this agent to answer: a person wrote it, in a DM with the agent, or mentioning it. */
const addressedTo = (m: Message, kind: string, agentId: string) => !!m.authorUserId && (kind === "dm" || m.mentions.some((x) => x.type === "agent" && x.id === agentId));

/** Returns null when there is nothing for this agent to answer (it has replied since it was last asked). */
export async function chatSnapshot(db: Database, conversationId: string, agentId: string): Promise<ChatSnapshot | null> {
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!conv) return null;
  const recent = (
    await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)).orderBy(desc(conversationMessages.createdAt)).limit(HISTORY_MESSAGES)
  ).reverse();
  const lastAsk = recent.findLast((m) => addressedTo(m, conv.kind, agentId));
  const lastReply = recent.findLast((m) => m.authorAgentId === agentId);
  if (!lastAsk || (lastReply && lastReply.createdAt > lastAsk.createdAt)) return null;

  const ids = [...new Set(recent.flatMap((m) => [m.authorUserId, m.authorAgentId]).filter((x): x is string => !!x))];
  const [people, bots] = await Promise.all([
    ids.length ? db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids)) : [],
    ids.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids)) : [],
  ]);
  const nameOf = (m: Message) =>
    m.authorAgentId === agentId ? "You" : (people.find((p) => p.id === m.authorUserId)?.name ?? bots.find((b) => b.id === m.authorAgentId)?.name ?? "Someone");
  const asker = people.find((p) => p.id === lastAsk.authorUserId)?.name ?? "Someone";
  const transcript = recent.map((m) => `${nameOf(m)}: ${m.body}`).join("\n\n");
  const where =
    conv.kind === "dm"
      ? `You are chatting with ${asker}, a MOSS user, in a direct message in the MOSS web UI. Reply to their latest message.`
      : `You are in the #${conv.name} channel in MOSS's chat, with people and other agents. ${asker} mentioned you; reply to what was ` +
        "asked of you (other agents answer for themselves).";
  const task =
    `${where} Use your tools if you need to look something up or act; anything that changes a system still needs an approved ` +
    "change request. Your final message is posted as your reply, so make it a direct answer in plain text.\n\n" +
    `Conversation so far (oldest first):\n\n${transcript}`;
  return { task, cutoff: lastAsk.createdAt };
}

/** Posts the run's outcome as the agent's reply, just after the message it answers. */
export async function recordChatReply(db: Database, conversationId: string, agentId: string, outcome: RunOutcome, cutoff: Date) {
  const status = outcome.status === "skipped" ? "aborted" : outcome.status;
  const at = new Date(cutoff.getTime() + 1);
  await db.insert(conversationMessages).values({ conversationId, authorAgentId: agentId, body: outcome.summary || "(no reply)", runId: outcome.runId, status, createdAt: at });
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}

/** Conversations this agent is in where something addressed to it came after its last message. */
export async function unansweredConversations(db: Database, agentId: string): Promise<string[]> {
  const mine = await db
    .select({ id: conversations.id, kind: conversations.kind })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversationMembers.agentId, agentId), eq(conversations.archived, false)));
  if (!mine.length) return [];
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(inArray(conversationMessages.conversationId, mine.map((c) => c.id)))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1000);
  const out: string[] = [];
  for (const c of mine) {
    const msgs = rows.filter((m) => m.conversationId === c.id); // newest first
    const reply = msgs.findIndex((m) => m.authorAgentId === agentId);
    const ask = msgs.findIndex((m) => addressedTo(m, c.kind, agentId));
    if (ask !== -1 && (reply === -1 || ask < reply)) out.push(c.id);
  }
  return out;
}
