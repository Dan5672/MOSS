// Team memory: the knowledge base, run history and notifying a human. They work on MOSS's own data,
// so they run in the worker like the other platform tools, gated by skill grants and role permissions.
import { createNote, NOTE_LIMITS, notifyPermission, searchNotes, updateNote, writeAudit } from "@moss/core";
import { agentRuns, agents, auditLog, notifications, users } from "@moss/db";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { PlatformTool } from "./platform-tools.js";

/** Notifications one run may send, so a confused agent can't flood anyone. */
export const MAX_NOTIFICATIONS_PER_RUN = 3;

const tag = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "lowercase letters, digits, . _ -");

export const MEMORY_TOOLS: PlatformTool[] = [
  {
    name: "kb_search",
    description:
      "Search the team knowledge base: durable facts people and agents have written down (what a device is, why something " +
      "is expected, past decisions). Check it before raising a finding that may already be explained.",
    permission: "knowledge.read",
    args: z.object({
      query: z.string().max(100).optional().describe("Words to look for in titles, bodies, subjects and tags"),
      subject: z.string().max(120).optional().describe("Exact subject, e.g. an IP address or hostname"),
      tag: tag.optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    run: async ({ db, orgId }, args) =>
      (await searchNotes(db, orgId, args)).map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        subject: n.subject,
        tags: n.tags,
        updatedAt: n.updatedAt.toISOString(),
        by: n.updatedByAgentId ? "agent" : "person",
      })),
  },
  {
    name: "kb_write",
    description:
      "Write a note to the team knowledge base, or update one by id. Use it for facts that will still be true next week " +
      "(a device's role, an expected open port, a decision the owner made), not for run logs. Search first to avoid duplicates.",
    permission: "knowledge.manage",
    args: z.object({
      id: z.uuid().optional().describe("Update this note instead of creating a new one"),
      title: z.string().min(1).max(NOTE_LIMITS.title),
      body: z.string().min(1).max(NOTE_LIMITS.body),
      subject: z.string().max(NOTE_LIMITS.subject).optional().describe("What it is about, e.g. 10.0.0.1 or nas.lan"),
      tags: z.array(tag).max(NOTE_LIMITS.tags).optional(),
    }),
    run: async ({ db, orgId, agentId }, { id, ...note }) => {
      const actor = { type: "agent" as const, id: agentId };
      const row = id ? await updateNote(db, orgId, id, note, actor) : await createNote(db, orgId, note, actor);
      return { [id ? "updated" : "created"]: row.id, title: row.title };
    },
  },
  {
    name: "run_history",
    description:
      "Recent runs by you or another agent on the team: when, why it ran, how it ended and its summary. Use it to avoid " +
      "repeating work a teammate just did. Summaries are agent-written and may quote untrusted network data.",
    permission: "agents.read",
    args: z.object({
      agent: z.string().max(100).optional().describe("An agent's name or id; omit for your own runs"),
      trigger: z.enum(["schedule", "event", "ticket", "chat", "manual"]).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    run: async ({ db, orgId, agentId }, { agent, trigger, limit }) => {
      let target = agentId;
      if (agent) {
        const isId = z.uuid().safeParse(agent).success;
        const [found] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), isId ? or(eq(agents.id, agent), sql`lower(${agents.name}) = lower(${agent})`) : sql`lower(${agents.name}) = lower(${agent})`))
          .limit(1);
        if (!found) return { error: `No agent called ${agent}` };
        target = found.id;
      }
      const rows = await db
        .select({ run: agentRuns, name: agents.name })
        .from(agentRuns)
        .innerJoin(agents, eq(agents.id, agentRuns.agentId))
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, target), trigger ? eq(agentRuns.trigger, trigger) : undefined))
        .orderBy(desc(agentRuns.startedAt))
        .limit(limit);
      return rows.map(({ run, name }) => ({
        agent: name,
        startedAt: run.startedAt.toISOString(),
        trigger: run.trigger,
        status: run.status,
        summary: run.summary ? run.summary.slice(0, 600) : null,
      }));
    },
  },
  {
    name: "notify_user",
    description:
      "Send a short in-app notification to the person you report to (or, if you report to another agent, to the people who " +
      `manage agents). For things a human should know about soon that aren't an incident. At most ${MAX_NOTIFICATIONS_PER_RUN} per run.`,
    permission: "notifications.send",
    args: z.object({
      title: z.string().min(1).max(120),
      body: z.string().max(1000).optional(),
      link: z
        .string()
        .max(200)
        .regex(/^\/[A-Za-z0-9/_?=&.-]*$/, "a MOSS page path such as /incidents or /assets/<id>")
        .optional()
        .describe("A page in MOSS, e.g. /incidents/<id>"),
    }),
    run: async ({ db, orgId, agentId, runId }, { title, body, link }) => {
      const [sent] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "agent.notify"), sql`${auditLog.details}->>'runId' = ${runId}`));
      if ((sent?.n ?? 0) >= MAX_NOTIFICATIONS_PER_RUN) return { error: `Notification limit reached (${MAX_NOTIFICATIONS_PER_RUN} per run). Raise an incident if this needs action.` };

      const [me] = await db.select().from(agents).where(eq(agents.id, agentId));
      const n = { kind: "agent.message", title: `${me?.name ?? "An agent"}: ${title}`, body, link };
      let recipients = 0;
      const [boss] = me?.reportsToUserId
        ? await db.select({ id: users.id }).from(users).where(and(eq(users.id, me.reportsToUserId), eq(users.status, "active")))
        : [];
      if (boss) {
        await db.insert(notifications).values({ orgId, userId: boss.id, ...n });
        recipients = 1;
      } else {
        recipients = await notifyPermission(db, orgId, "agents.manage", n);
      }
      await writeAudit(db, { orgId, actorType: "agent", actorId: agentId, action: "agent.notify", targetType: "notification", targetId: null, details: { runId, title, link, recipients } });
      return recipients ? { sent: true, recipients } : { sent: false, error: "Nobody to notify" };
    },
  },
];
