"use server";

import { writeAudit } from "@moss/core";
import { agents, chatMessages, chatThreads } from "@moss/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { queueRun } from "@/server/services";

/** The user's current conversation with this agent, started if there isn't one. */
async function currentThread(orgId: string, agentId: string, userId: string) {
  const [thread] = await db()
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.agentId, agentId), eq(chatThreads.userId, userId)))
    .orderBy(desc(chatThreads.createdAt))
    .limit(1);
  return thread ?? (await db().insert(chatThreads).values({ orgId, agentId, userId }).returning())[0]!;
}

export async function sendChatAction(agentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.chat");
    const text = z.string().trim().min(1, "Write a message").max(4000).parse(form.get("message"));
    const [agent] = await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId)));
    if (!agent) throw new Error("Agent not found");
    if (agent.status !== "active") throw new Error(`${agent.name} is ${agent.status} and can't reply`);

    const thread = await currentThread(user.orgId, agentId, user.id);
    await db().insert(chatMessages).values({ threadId: thread.id, role: "user", content: text });
    await db().update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, thread.id));
    // If the agent is busy this isn't queued; the worker answers waiting messages when the current run ends.
    await queueRun({ agentId, trigger: "chat", triggerRef: thread.id, task: text });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "agent.chat", targetType: "agent", targetId: agentId, details: { threadId: thread.id, message: text } });
  });
}

export async function newConversationAction(agentId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.chat");
    const [agent] = await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId)));
    if (!agent) throw new Error("Agent not found");
    await db().insert(chatThreads).values({ orgId: user.orgId, agentId, userId: user.id });
    return "Started a new conversation.";
  });
}
