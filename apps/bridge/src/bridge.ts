// The bridge: one bot per switched-on chat app per org, started and stopped as the gate's list of bot tokens
// changes. What people send is handled by core (linking, commands, chatting with agents, approvals); what MOSS
// sends goes through the outbox, a few seconds after it's queued.
import { enqueueRun } from "@moss/agent";
import { chatOutboxBatch, handleButton, handleIncoming, markChatSent, pruneChatOutbox, queueChatMessages, writeAudit, type ChatPlatform } from "@moss/core";
import type { Database } from "@moss/db";
import type { PgBoss } from "pg-boss";
import { DiscordBot } from "./discord.js";
import { TelegramBot } from "./telegram.js";
import type { Bot, BotHandlers } from "./types.js";

export interface Credential {
  orgId: string;
  platform: ChatPlatform;
  token: string;
}

export interface BridgeDeps {
  db: Database;
  boss: Pick<PgBoss, "send">;
  /** The bot tokens of switched-on chat apps, from the gate. */
  credentials: () => Promise<Credential[]>;
  makeBot?: (c: Credential, handlers: BotHandlers) => Bot;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const defaultBot = (c: Credential, h: BotHandlers): Bot => (c.platform === "telegram" ? new TelegramBot(c.token, h) : new DiscordBot(c.token, h));

export function createBridge(deps: BridgeDeps) {
  const bots = new Map<string, { token: string; bot: Bot; orgId: string; platform: ChatPlatform }>();

  const handlers = (orgId: string, platform: ChatPlatform): BotHandlers => ({
    message: async (m) => {
      const res = await handleIncoming(deps.db, { orgId, platform, ...m });
      if (res.run) {
        // If the agent is busy this waits its turn, as in MOSS's own chat.
        await enqueueRun(deps.boss as PgBoss, { agentId: res.run.agentId, trigger: "chat", triggerRef: res.run.conversationId, task: "Reply in chat", requestedByUserId: res.run.userId });
        await writeAudit(deps.db, {
          orgId,
          actorType: "user",
          actorId: res.run.userId,
          action: "agent.chat",
          targetType: "conversation",
          targetId: res.run.conversationId,
          details: { agents: [res.run.agentId], via: platform, message: m.text.slice(0, 500) },
        });
      }
      return res.replies;
    },
    button: async (b) => (await handleButton(deps.db, { orgId, platform, ...b })).text,
    log: (msg, extra) => deps.log(msg, { orgId, platform, ...extra }),
  });

  /** Starts bots for new tokens, restarts ones whose token changed, stops ones switched off. */
  async function sync() {
    const creds = await deps.credentials();
    const want = new Map(creds.map((c) => [`${c.orgId}:${c.platform}`, c]));
    for (const [key, b] of bots) {
      const c = want.get(key);
      if (!c || c.token !== b.token) {
        b.bot.stop();
        bots.delete(key);
        deps.log("chat bot stopped", { orgId: b.orgId, platform: b.platform });
      }
    }
    for (const [key, c] of want) {
      if (bots.has(key)) continue;
      const bot = (deps.makeBot ?? defaultBot)(c, handlers(c.orgId, c.platform));
      bots.set(key, { token: c.token, bot, orgId: c.orgId, platform: c.platform });
      bot.start();
      deps.log("chat bot started", { orgId: c.orgId, platform: c.platform });
    }
  }

  /** Queues new notifications and agents' replies, then sends what's waiting. */
  async function flush() {
    await queueChatMessages(deps.db);
    for (const b of bots.values()) {
      for (const row of await chatOutboxBatch(deps.db, b.orgId, b.platform)) {
        try {
          await b.bot.send(row.chatId, row.text, row.buttons);
          await markChatSent(deps.db, row.id);
        } catch (err) {
          await markChatSent(deps.db, row.id, (err as Error).message);
          deps.log("chat message not sent", { platform: b.platform, error: (err as Error).message });
        }
      }
    }
  }

  return {
    sync,
    flush,
    prune: () => pruneChatOutbox(deps.db),
    stop: () => {
      for (const b of bots.values()) b.bot.stop();
      bots.clear();
    },
    running: () => [...bots.keys()],
  };
}
