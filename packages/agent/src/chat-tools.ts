// Agents in MOSS's chat: posting to a channel they've been added to. (Replying to a DM or a mention needs no
// tool: a chat run's final message is posted as the reply.) What an agent posts is its own words, so it
// never starts another agent's run: only people's messages do.
import { postMessage } from "@moss/core";
import { conversationMembers, conversationMessages, conversations } from "@moss/db";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { PlatformTool } from "./platform-tools.js";

export const MAX_CHAT_POSTS_PER_RUN = 5;

export const CHAT_TOOLS: PlatformTool[] = [
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
