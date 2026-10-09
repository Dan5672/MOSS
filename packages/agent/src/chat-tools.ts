// Agents in MOSS's chat: asking a person a question mid-task (ask_user), and posting to a channel they've
// been added to (chat_post). (Replying to a DM or a mention needs no
// tool: a chat run's final message is posted as the reply.) What an agent posts is its own words, so it
// never starts another agent's run: only people's messages do.
import { openDm, postMessage } from "@moss/core";
import { agentRuns, agents, conversationMembers, conversationMessages, conversations, notifications, rolePermissions, userRoles, users } from "@moss/db";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { PlatformTool } from "./platform-tools.js";

export const MAX_CHAT_POSTS_PER_RUN = 5;

/** Who an agent asks: the person who asked for this work, else the person it reports to, else someone who manages agents. */
async function whoToAsk(db: Parameters<PlatformTool["run"]>[0]["db"], orgId: string, agentId: string, runId: string): Promise<string | null> {
  const [run] = await db.select({ requestedBy: agentRuns.requestedByUserId }).from(agentRuns).where(eq(agentRuns.id, runId));
  if (run?.requestedBy) return run.requestedBy;
  const [agent] = await db.select({ reportsTo: agents.reportsToUserId }).from(agents).where(eq(agents.id, agentId));
  if (agent?.reportsTo) return agent.reportsTo;
  const [manager] = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(rolePermissions, and(eq(rolePermissions.roleId, userRoles.roleId), eq(rolePermissions.permission, "agents.manage")))
    .where(and(eq(users.orgId, orgId), eq(users.status, "active")))
    .limit(1);
  return manager?.id ?? null;
}

export const CHAT_TOOLS: PlatformTool[] = [
  {
    name: "ask_user",
    description:
      "Ask a person a question you need answered before you can carry on: a choice between options, missing information, or a go-ahead. " +
      "It goes to the person who gave you this task (or who you report to) as a chat message. Then stop: finish this run with a short " +
      "summary saying what you're waiting for. Their answer comes back to you as a new chat task with the conversation. Once per run; " +
      "not needed in a chat, where you just ask in your reply.",
    permission: "notifications.send",
    args: z.object({ question: z.string().min(1).max(2000) }),
    run: async ({ db, orgId, agentId, runId }, { question }) => {
      const [run] = await db.select({ trigger: agentRuns.trigger, task: agentRuns.task }).from(agentRuns).where(eq(agentRuns.id, runId));
      if (run?.trigger === "chat") return { error: "You're already in a chat: ask in your reply instead." };
      const [asked] = await db
        .select({ n: count() })
        .from(conversationMessages)
        .innerJoin(conversations, and(eq(conversations.id, conversationMessages.conversationId), eq(conversations.kind, "dm")))
        .where(and(eq(conversationMessages.authorAgentId, agentId), eq(conversationMessages.runId, runId)));
      if ((asked?.n ?? 0) >= 1) return { error: "You've already asked a question in this run. Finish it and wait for the answer." };
      const userId = await whoToAsk(db, orgId, agentId, runId);
      if (!userId) return { error: "There's nobody to ask. Raise an incident instead." };
      const conversationId = await openDm(db, orgId, userId, { type: "agent", id: agentId });
      const context = run?.task ? `\n\n(I'm asking while working on: ${run.task.replace(/\s+/g, " ").slice(0, 300)})` : "";
      const { messageId } = await postMessage(db, orgId, conversationId, { type: "agent", id: agentId }, `${question}${context}`);
      await db.update(conversationMessages).set({ runId }).where(eq(conversationMessages.id, messageId));
      const [me] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
      await db.insert(notifications).values({ orgId, userId, kind: "agent.question", title: `${me?.name ?? "An agent"} has a question for you`, body: question.slice(0, 500), link: `/chat/${conversationId}` });
      return { ok: true, sent: "Asked in a direct message. Finish this run now with a short summary saying what you're waiting for." };
    },
  },
  {
    name: "chat_post",
    description:
      "Post a message in a chat channel you're a member of (e.g. #network), for updates the people there should see. " +
      `At most ${MAX_CHAT_POSTS_PER_RUN} per run. You can @mention people by name.`,
    permission: "notifications.send",
    args: z.object({
      channel: z.string().min(1).max(41).describe("The channel's name, with or without #"),
      message: z.string().min(1).max(4000),
    }),
    run: async ({ db, orgId, agentId, runId }, { channel, message }) => {
      const name = channel.replace(/^#/, "").toLowerCase();
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.agentId, agentId)))
        .where(and(eq(conversations.orgId, orgId), eq(conversations.kind, "channel"), eq(conversations.name, name)));
      if (!conv) return { error: `You're not in #${name}. Someone has to add you (or @mention you there) first.` };
      const [posted] = await db
        .select({ n: count() })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.authorAgentId, agentId), eq(conversationMessages.runId, runId)));
      if ((posted?.n ?? 0) >= MAX_CHAT_POSTS_PER_RUN) return { error: `Chat limit reached (${MAX_CHAT_POSTS_PER_RUN} posts per run).` };
      const { messageId } = await postMessage(db, orgId, conv.id, { type: "agent", id: agentId }, message);
      await db.update(conversationMessages).set({ runId }).where(eq(conversationMessages.id, messageId));
      return { ok: true, channel: `#${name}` };
    },
  },
];
