// Telegram and Discord: what the bridge service does with what people send its bot, and what it sends them.
// People link their chat account to their MOSS account with a one-time code; everything else from accounts that
// aren't linked is ignored. Linked people get their MOSS notifications (incidents, monitors, changes awaiting
// approval, mentions), can approve or reject changes with buttons, and can talk to their agents.
import { agents, changeRequests, chatLinkCodes, chatLinks, chatOutbox, conversationMembers, conversationMessages, conversations, modules, notifications, users, type Database } from "@moss/db";
import { BUILT_IN_TOOLS } from "@moss/tools";
import { and, asc, eq, isNotNull, isNull, lte, sql, type AnyColumn } from "drizzle-orm";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { approveChange, assessRisk, rejectChange } from "../services/changes.js";
import { openDm, postMessage } from "../services/conversations.js";
import { loadModule } from "../services/modules.js";
import { userPermissions } from "../services/notifications.js";
import { getSetting } from "../store/settings-store.js";
import { integrationLicensed } from "../licensing/service.js";

export const CHAT_PLATFORMS = ["telegram", "discord", "slack"] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];
export const CHAT_NAMES: Record<ChatPlatform, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack" };
/** The secret holding each bot's token. Only the gate decrypts it, for the bridge. */
export const CHAT_TOKEN_SECRET: Record<ChatPlatform, string> = { telegram: "telegram-bot-token", discord: "discord-bot-token", slack: "slack-bot-token" };
/** Slack's app-level token, for its Socket Mode connection (the bot token above sends messages). */
export const SLACK_APP_TOKEN_SECRET = "slack-app-token";
/** Business chat apps need a licence that covers them (their key is the licence feature). */
export const CHAT_PLAN: Record<ChatPlatform, "free" | "business"> = { telegram: "free", discord: "free", slack: "business" };

/** Whether this org may use the chat app (Telegram and Discord always; Slack with a licence). */
export async function chatLicensed(db: Pick<Database, "select">, orgId: string, platform: ChatPlatform): Promise<boolean> {
  return integrationLicensed(db as Database, orgId, { key: platform, plan: CHAT_PLAN[platform] });
}

const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export const chatConfigSchema = z.object({
  /** What people get: incidents (from this priority up), monitors, changes awaiting approval, mentions and messages. */
  incidents: z.boolean().default(true).catch(true),
  minPriority: z.enum(PRIORITIES).default("P2").catch("P2"),
  monitors: z.boolean().default(true).catch(true),
  changes: z.boolean().default(true).catch(true),
  messages: z.boolean().default(true).catch(true),
  /** Approve and Reject buttons on changes (only for changes that may be approved from a chat app). */
  approvals: z.boolean().default(true).catch(true),
  /** MOSS's address as phones reach it, for links in messages. */
  mossUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/]+(:\d+)?\/?$/)
    .optional()
    .catch(undefined),
});
export type ChatConfig = z.infer<typeof chatConfigSchema>;

export async function loadChatModule(db: Pick<Database, "select">, orgId: string, platform: ChatPlatform) {
  const row = await loadModule(db, orgId, platform);
  // An unlicensed business chat app counts as off everywhere (its settings are kept).
  return { enabled: row.enabled && (await chatLicensed(db, orgId, platform)), config: chatConfigSchema.parse(row.config ?? {}) };
}

// --- Linking ----------------------------------------------------------------------------------------

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const hashCode = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

/** A one-time code (valid 10 minutes) the person sends the bot as /link CODE. */
export async function createLinkCode(db: Database, orgId: string, userId: string, platform: ChatPlatform, now = new Date()): Promise<string> {
  const code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
  await db.delete(chatLinkCodes).where(and(eq(chatLinkCodes.userId, userId), eq(chatLinkCodes.platform, platform)));
  await db.insert(chatLinkCodes).values({ codeHash: hashCode(code), orgId, userId, platform, expiresAt: new Date(now.getTime() + 10 * 60_000) });
  return code;
}

export async function listChatLinks(db: Pick<Database, "select">, orgId: string, userId?: string) {
  return db
    .select({ id: chatLinks.id, platform: chatLinks.platform, username: chatLinks.username, userId: chatLinks.userId, userName: users.displayName, createdAt: chatLinks.createdAt })
    .from(chatLinks)
    .innerJoin(users, eq(users.id, chatLinks.userId))
    .where(userId ? and(eq(chatLinks.orgId, orgId), eq(chatLinks.userId, userId)) : eq(chatLinks.orgId, orgId))
    .orderBy(asc(chatLinks.createdAt));
}

export async function unlinkChat(db: Database, orgId: string, linkId: string, userId?: string) {
  await db.delete(chatLinks).where(and(eq(chatLinks.id, linkId), eq(chatLinks.orgId, orgId), ...(userId ? [eq(chatLinks.userId, userId)] : [])));
}

// --- What people send -------------------------------------------------------------------------------

export interface Incoming {
  orgId: string;
  platform: ChatPlatform;
  externalUserId: string;
  chatId: string;
  username?: string;
  text: string;
}

export interface IncomingResult {
  /** What the bot says back. */
  replies: string[];
  /** An agent to wake up to answer (the bridge queues its run). */
  run?: { agentId: string; conversationId: string; userId: string };
}

const HELP = [
  "Message me to talk to Moss, MOSS's own agent.",
  "/agents lists the agents you can talk to, /agent <name> switches to one.",
  "/unlink disconnects this account from MOSS.",
].join("\n");

async function linkFor(db: Pick<Database, "select">, platform: ChatPlatform, externalUserId: string, orgId: string) {
  const [link] = await db
    .select()
    .from(chatLinks)
    .where(and(eq(chatLinks.platform, platform), eq(chatLinks.externalUserId, externalUserId), eq(chatLinks.orgId, orgId)));
  if (!link) return null;
  const [user] = await db.select().from(users).where(eq(users.id, link.userId));
  return user && user.status === "active" ? { link, user } : null;
}

/** Agents a person can chat with: working ones, Moss first. */
async function chatAgents(db: Pick<Database, "select">, orgId: string) {
  const rows = await db.select({ id: agents.id, name: agents.name, title: agents.title, templateKey: agents.templateKey }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.status, "active")));
  return rows.sort((a, b) => Number(b.templateKey === "moss") - Number(a.templateKey === "moss") || a.name.localeCompare(b.name));
}

export async function handleIncoming(db: Database, m: Incoming, now = new Date()): Promise<IncomingResult> {
  const text = m.text.trim();
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const name = CHAT_NAMES[m.platform];

  if (/^\/link$/i.test(command ?? "")) {
    const [code] = await db.select().from(chatLinkCodes).where(eq(chatLinkCodes.codeHash, hashCode(arg)));
    if (!code || code.orgId !== m.orgId || code.platform !== m.platform || code.expiresAt <= now) {
      return { replies: [`That code didn't work. Make a new one in MOSS: Settings → General → Connect ${name}.`] };
    }
    await db.delete(chatLinkCodes).where(eq(chatLinkCodes.codeHash, code.codeHash));
    // One account per person per app, and one person per account.
    await db.delete(chatLinks).where(and(eq(chatLinks.platform, m.platform), eq(chatLinks.userId, code.userId)));
    await db.delete(chatLinks).where(and(eq(chatLinks.platform, m.platform), eq(chatLinks.externalUserId, m.externalUserId)));
    await db.insert(chatLinks).values({ orgId: m.orgId, userId: code.userId, platform: m.platform, externalUserId: m.externalUserId, chatId: m.chatId, username: m.username?.slice(0, 100) ?? null });
    const [u] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, code.userId));
    return { replies: [`Linked to ${u?.name ?? "your MOSS account"}. You'll get your MOSS notifications here.\n\n${HELP}`] };
  }

  const who = await linkFor(db, m.platform, m.externalUserId, m.orgId);
  if (!who) {
    return { replies: [`This is your MOSS bot. To use it, link your account: in MOSS, Settings → General → Connect ${name}, then send me /link and the code.`] };
  }
  const { link, user } = who;

  if (/^\/(start|help)$/i.test(command ?? "")) return { replies: [HELP] };
  if (/^\/unlink$/i.test(command ?? "")) {
    await db.delete(chatLinks).where(eq(chatLinks.id, link.id));
    return { replies: ["Disconnected. You won't get MOSS notifications here any more."] };
  }
  const list = await chatAgents(db, m.orgId);
  if (/^\/agents$/i.test(command ?? "")) {
    return { replies: [list.length ? `You can talk to:\n${list.map((a) => `• ${a.name} (${a.title})`).join("\n")}\n\nSwitch with /agent <name>.` : "There are no agents working right now."] };
  }
  if (/^\/agent$/i.test(command ?? "")) {
    const pick = list.find((a) => a.name.toLowerCase() === arg.toLowerCase());
    if (!pick) return { replies: [`No working agent called "${arg}". /agents lists them.`] };
    await db.update(chatLinks).set({ agentId: pick.id }).where(eq(chatLinks.id, link.id));
    return { replies: [`You're now talking to ${pick.name}.`] };
  }
  if (command?.startsWith("/")) return { replies: [`I don't know ${command}.\n\n${HELP}`] };

  const perms = await userPermissions(db, user.id);
  if (!perms.has("agents.chat")) return { replies: ["Your MOSS account isn't allowed to chat with agents."] };
  const agent = list.find((a) => a.id === link.agentId) ?? list[0];
  if (!agent) return { replies: ["There are no agents working right now."] };
  const conversationId = await openDm(db, m.orgId, user.id, { type: "agent", id: agent.id });
  const posted = await postMessage(db, m.orgId, conversationId, { type: "user", id: user.id }, text.slice(0, 8000));
  // Their own message isn't sent back to them.
  await db.update(chatLinks).set({ repliesForwardedAt: now }).where(and(eq(chatLinks.id, link.id), lte(chatLinks.repliesForwardedAt, now)));
  return posted.agentsToAnswer.includes(agent.id) ? { replies: [], run: { agentId: agent.id, conversationId, userId: user.id } } : { replies: [] };
}

/** What a change will do, one line per planned call, for approvers who only see the chat message. */
export function describePlan(calls: { tool: string; args: Record<string, unknown> }[]): string {
  if (calls.length === 0) return "";
  const shown = calls.slice(0, 10).map((c, i) => `${i + 1}. ${c.tool} ${JSON.stringify(c.args)}`.slice(0, 240));
  if (calls.length > shown.length) shown.push(`…and ${calls.length - shown.length} more`);
  return `\n\nPlanned steps:\n${shown.join("\n")}`;
}

// --- Buttons ---------------------------------------------------------------------------------------

/** Why a change can't be decided from a chat app (it must be done in MOSS), or null. */
/** What the owner lets chat apps approve (Settings, Safety). */
export interface ChatApprovalRules {
  level: "standard" | "low_risk" | "off";
  /** Approving needs a two-factor code, which a chat button can't give. */
  totp: boolean;
}

export async function chatApprovalRules(db: Database, orgId: string): Promise<ChatApprovalRules> {
  const [level, totp] = await Promise.all([getSetting(db, orgId, "changes.chat_approvals"), getSetting(db, orgId, "changes.approval_totp")]);
  return { level, totp };
}

export function chatApprovalBlocked(
  c: Pick<typeof changeRequests.$inferSelect, "type" | "risk" | "plannedCalls" | "accessGrant">,
  rules: ChatApprovalRules = { level: "standard", totp: false },
): string | null {
  if (rules.level === "off") return "Changes are approved in MOSS.";
  if (rules.totp) return "Approving needs your two-factor code, so it's done in MOSS.";
  if (c.type === "emergency") return "Emergency changes are reviewed in MOSS.";
  // The plan's own risk too, not only the stored one, which whoever raised the change wrote.
  const risk = c.risk === "high" ? "high" : assessRisk(c.risk, c.plannedCalls);
  if (risk === "high") return "High-risk changes are approved in MOSS.";
  if (rules.level === "low_risk" && risk !== "low") return "Only low-risk changes are approved from chat.";
  if (c.accessGrant) return "Access for an agent is approved in MOSS.";
  if (c.plannedCalls.some((p) => BUILT_IN_TOOLS.get(p.tool)?.manifest.class === "dangerous")) return "Changes with dangerous tools are approved in MOSS.";
  return null;
}

export async function handleButton(db: Database, b: { orgId: string; platform: ChatPlatform; externalUserId: string; data: string }): Promise<{ text: string }> {
  const m = /^(approve|reject):([0-9a-f-]{36})$/.exec(b.data);
  if (!m) return { text: "That button no longer does anything." };
  const who = await linkFor(db, b.platform, b.externalUserId, b.orgId);
  if (!who) return { text: "Link your MOSS account first." };
  const { enabled, config } = await loadChatModule(db, b.orgId, b.platform);
  if (!enabled || !config.approvals) return { text: "Approving from here is switched off." };
  if (!(await userPermissions(db, who.user.id)).has("changes.approve")) return { text: "Your MOSS account can't approve changes." };
  const [change] = await db.select().from(changeRequests).where(and(eq(changeRequests.id, m[2]!), eq(changeRequests.orgId, b.orgId)));
  if (!change) return { text: "That change no longer exists." };
  if (change.status !== "submitted") return { text: `That change is ${change.status.replace(/_/g, " ")} already.` };
  const blocked = chatApprovalBlocked(change, await chatApprovalRules(db, b.orgId));
  if (blocked) return { text: blocked };
  try {
    if (m[1] === "approve") {
      await approveChange(db, b.orgId, change.id, who.user.id, { comment: `Approved from ${CHAT_NAMES[b.platform]}` });
      return { text: `Approved by ${who.user.displayName}.` };
    }
    await rejectChange(db, b.orgId, change.id, who.user.id, `Rejected from ${CHAT_NAMES[b.platform]}`);
    return { text: `Rejected by ${who.user.displayName}.` };
  } catch (err) {
    return { text: (err as Error).message };
  }
}

// --- What MOSS sends -------------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

/** Whether a notification goes to the chat app, by the platform's settings. */
export function wantsNotification(c: ChatConfig, n: { kind: string; title: string }): boolean {
  if (n.kind === "incident") {
    const p = /^(P[1-4])\b/.exec(n.title)?.[1];
    return c.incidents && (!p || PRIORITY_RANK[p]! <= PRIORITY_RANK[c.minPriority]!);
  }
  if (n.kind === "monitor") return c.monitors;
  if (n.kind === "change") return c.changes;
  if (["mention", "comment", "dm", "channel", "execution"].includes(n.kind)) return c.messages;
  return c.incidents; // system, home_assistant and the like: operational news
}

/** Postgres keeps microseconds, JavaScript milliseconds: compare at milliseconds so a saved place matches exactly. */
const after = (col: AnyColumn, t: Date) => sql`date_trunc('milliseconds', ${col}) > ${t.toISOString()}::timestamptz`;

const link = (c: ChatConfig, path: string | null) => (path && c.mossUrl ? `\n${c.mossUrl.replace(/\/+$/, "")}${path}` : "");

/**
 * Queues each linked person's new notifications, and agents' replies in their DMs, for the bridge to send. Runs
 * every few seconds; each link keeps its own place.
 */
export async function queueChatMessages(db: Database, now = new Date()): Promise<number> {
  let queued = 0;
  const links = await db.select().from(chatLinks);
  for (const l of links) {
    const { enabled, config } = await loadChatModule(db, l.orgId, l.platform);
    if (!enabled) continue;
    const rows: (typeof chatOutbox.$inferInsert)[] = [];

    const news = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, l.userId), after(notifications.createdAt, l.notifiedAt), lte(notifications.createdAt, now)))
      .orderBy(asc(notifications.createdAt))
      .limit(50);
    for (const n of news) {
      if (!wantsNotification(config, n)) continue;
      // DMs with agents come through as the agents' replies below.
      if (n.kind === "dm") continue;
      const changeId = n.kind === "change" ? /^\/changes\/([0-9a-f-]{36})$/.exec(n.link ?? "")?.[1] : undefined;
      let buttons: { label: string; data: string }[] = [];
      let plan = "";
      if (changeId) {
        const [c] = await db.select().from(changeRequests).where(eq(changeRequests.id, changeId));
        if (c) plan = describePlan(c.plannedCalls);
        if (c && config.approvals && c.status === "submitted" && !chatApprovalBlocked(c, await chatApprovalRules(db, c.orgId))) buttons = [{ label: "Approve", data: `approve:${c.id}` }, { label: "Reject", data: `reject:${c.id}` }];
      }
      // The plan comes straight after the title, so the agent's description can't push it past the length cap.
      rows.push({ orgId: l.orgId, platform: l.platform, chatId: l.chatId, text: `${n.title}${plan}${n.body ? `\n\n${n.body}` : ""}${link(config, n.link)}`.slice(0, 3500), buttons });
    }

    // Agents' replies in this person's DMs since the last time.
    const replies = await db
      .select({ body: conversationMessages.body, createdAt: conversationMessages.createdAt, agentName: agents.name })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, conversations.id), eq(conversationMembers.userId, l.userId)))
      .innerJoin(agents, eq(agents.id, conversationMessages.authorAgentId))
      .where(and(eq(conversations.kind, "dm"), eq(conversations.orgId, l.orgId), isNotNull(conversationMessages.authorAgentId), after(conversationMessages.createdAt, l.repliesForwardedAt), lte(conversationMessages.createdAt, now)))
      .orderBy(asc(conversationMessages.createdAt))
      .limit(20);
    if (config.messages) for (const r of replies) rows.push({ orgId: l.orgId, platform: l.platform, chatId: l.chatId, text: `${r.agentName}: ${r.body}`.slice(0, 3500), buttons: [] });

    const lastNews = news.at(-1)?.createdAt;
    const lastReply = replies.at(-1)?.createdAt;
    await db.transaction(async (tx) => {
      if (rows.length) await tx.insert(chatOutbox).values(rows);
      if (lastNews || lastReply) {
        await tx
          .update(chatLinks)
          .set({ ...(lastNews ? { notifiedAt: lastNews } : {}), ...(lastReply ? { repliesForwardedAt: lastReply } : {}) })
          .where(eq(chatLinks.id, l.id));
      }
    });
    queued += rows.length;
  }
  return queued;
}

/** Messages to send now (unsent, a few tries at most), oldest first. */
export async function chatOutboxBatch(db: Database, orgId: string, platform: ChatPlatform, limit = 20) {
  return db
    .select()
    .from(chatOutbox)
    .where(and(eq(chatOutbox.orgId, orgId), eq(chatOutbox.platform, platform), isNull(chatOutbox.sentAt), sql`${chatOutbox.attempts} < 5`))
    .orderBy(asc(chatOutbox.id))
    .limit(limit);
}

export async function markChatSent(db: Database, id: number, error?: string) {
  await db
    .update(chatOutbox)
    .set(error ? { attempts: sql`${chatOutbox.attempts} + 1`, error: error.slice(0, 500) } : { sentAt: new Date(), error: null })
    .where(eq(chatOutbox.id, id));
}

/** Old sent messages are dropped after a week. */
export async function pruneChatOutbox(db: Database, now = new Date()) {
  await db.delete(chatOutbox).where(and(isNotNull(chatOutbox.sentAt), lte(chatOutbox.createdAt, new Date(now.getTime() - 7 * 86_400_000))));
}

/** Orgs with a platform switched on: the bridge runs a bot for each. */
export async function chatEnabledOrgs(db: Pick<Database, "select">, platform: ChatPlatform): Promise<string[]> {
  const rows = await db.select({ orgId: modules.orgId }).from(modules).where(and(eq(modules.key, platform), eq(modules.enabled, true)));
  const out: string[] = [];
  for (const r of rows) if (await chatLicensed(db, r.orgId, platform)) out.push(r.orgId);
  return out;
}
