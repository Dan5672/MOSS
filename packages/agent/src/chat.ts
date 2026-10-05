// Chat with agents. A user's message is stored, then a run with trigger "chat" (triggerRef = thread id)
// answers it: the worker builds the run's task from the conversation, and the run's final summary is
// stored as the agent's reply. Chat is just another way to start a run, so the policy gate, budgets,
// step limits and audit all apply as they do to scheduled work.
import { chatMessages, chatThreads, users, type Database } from "@moss/db";
import { desc, eq } from "drizzle-orm";
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

/** Returns null when there is nothing to answer (every message already has a reply). */
export async function chatSnapshot(db: Database, threadId: string): Promise<ChatSnapshot | null> {
  const [thread] = await db
    .select({ userName: users.displayName })
    .from(chatThreads)
    .innerJoin(users, eq(users.id, chatThreads.userId))
    .where(eq(chatThreads.id, threadId));
  if (!thread) return null;
  const recent = (
    await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(desc(chatMessages.createdAt)).limit(HISTORY_MESSAGES)
  ).reverse();
  const latest = recent.at(-1);
  if (!latest || latest.role !== "user") return null;

  const transcript = recent.map((m) => `${m.role === "user" ? thread.userName : "You"}: ${m.content}`).join("\n\n");
  const task =
    `You are chatting with ${thread.userName}, a MOSS user, in the MOSS web UI. Reply to their latest message. ` +
    "Use your tools if you need to look something up or act; anything that changes a system still needs an approved " +
    "change request. Your final message is shown to them as your reply, so make it a direct answer in plain text.\n\n" +
    `Conversation so far (oldest first):\n\n${transcript}`;
  return { task, cutoff: latest.createdAt };
}

/** Stores the run's outcome as the agent's reply. */
export async function recordChatReply(db: Database, threadId: string, outcome: RunOutcome, cutoff: Date) {
  const status = outcome.status === "skipped" ? "aborted" : outcome.status;
  await db.insert(chatMessages).values({
    threadId,
    role: "agent",
    content: outcome.summary || "(no reply)",
    runId: outcome.runId,
    status,
    createdAt: new Date(cutoff.getTime() + 1),
  });
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, threadId));
}

/** Threads with this agent whose newest message is still waiting for a reply. */
export async function unansweredThreads(db: Database, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ threadId: chatMessages.threadId, role: chatMessages.role })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(eq(chatThreads.agentId, agentId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(500);
  const latest = new Map<string, string>();
  for (const r of rows) if (!latest.has(r.threadId)) latest.set(r.threadId, r.role);
  return [...latest].filter(([, role]) => role === "user").map(([id]) => id);
}
