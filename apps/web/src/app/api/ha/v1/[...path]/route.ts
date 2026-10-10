// The Home Assistant integration's API. Bearer-token only (a token from Settings > Modules > Home
// Assistant), acting as the person who made the token and never beyond their permissions. Deliberately
// small and safe: Home Assistant can read MOSS's state, make it do less (pause agents, quiet monitors) and
// ask it things (raise an incident, ask an agent, check a monitor, run a recurring task). It can't approve
// changes, touch secrets, tools, networks or settings, or resume agents unless the owner allowed that.
import { pauseAgent, resumeAgent } from "@moss/agent";
import {
  checkMonitorNow,
  createIncident,
  getSetting,
  incidentRef,
  openDm,
  postMessage,
  setSetting,
  userPermissions,
  verifyIntegrationToken,
  writeAudit,
  type IntegrationCaller,
} from "@moss/core";
import { agents, agentSchedules, conversationMessages, incidentComments, incidents, monitors } from "@moss/db";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { haCalendar, haEvents, haSnapshot } from "@/server/ha-api";
import { workingAgents } from "@/server/people";
import { queueRun } from "@/server/services";

export const dynamic = "force-dynamic";

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function caller(req: Request): Promise<IntegrationCaller> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const c = await verifyIntegrationToken(db(), token);
  if (!c) throw new ApiError(401, "Invalid or revoked token. Make a new one in MOSS: Settings > Modules > Home Assistant.");
  return c;
}

async function need(c: IntegrationCaller, permission: Parameters<Set<string>["has"]>[0]) {
  const perms = await userPermissions(db(), c.userId);
  if (!perms.has(permission as never)) throw new ApiError(403, `The person who made this token doesn't have permission (${permission}).`);
}

const audit = (c: IntegrationCaller, action: string, targetType: string, targetId: string | null, details: Record<string, unknown> = {}) =>
  writeAudit(db(), { orgId: c.orgId, actorType: "user", actorId: c.userId, action, targetType, targetId, details: { ...details, via: "home_assistant", token: c.tokenName } });

/** An agent by id or (case-insensitive) name, among this org's agents. */
async function findAgent(orgId: string, ref: string) {
  const rows = await db()
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired")));
  const a = rows.find((r) => r.id === ref) ?? rows.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase());
  if (!a) throw new ApiError(404, `No agent called ${ref}`);
  return a;
}

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const raw = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

async function handle(req: Request, path: string[], method: "GET" | "POST") {
  const c = await caller(req);
  const url = new URL(req.url);
  const route = `${method} ${path.map((p) => (/^[0-9a-f-]{36}$/.test(p) ? ":id" : p)).join("/")}`;
  const id = path.find((p) => /^[0-9a-f-]{36}$/.test(p));

  switch (route) {
    case "GET state":
      return haSnapshot(c.orgId);

    case "GET events": {
      const after = url.searchParams.get("after");
      return haEvents(c.orgId, after === null ? null : Number(after) || 0);
    }

    case "GET calendar": {
      const start = new Date(url.searchParams.get("start") ?? Date.now());
      const end = new Date(url.searchParams.get("end") ?? Date.now() + 7 * 86_400_000);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new ApiError(400, "start and end must be times, start first");
      if (end.getTime() - start.getTime() > 62 * 86_400_000) throw new ApiError(400, "At most two months at a time");
      return { events: await haCalendar(c.orgId, start, end) };
    }

    // Pausing only ever makes MOSS do less, so it's always allowed (with the kill switch permission).
    case "POST agents/pause": {
      await need(c, "killswitch.use");
      await setSetting(db(), c.orgId, "agents.kill_switch", true);
      await audit(c, "setting.update", "setting", "agents.kill_switch", { value: true });
      return { ok: true, message: "All agents are paused." };
    }
    case "POST agents/resume": {
      await need(c, "killswitch.use");
      if (!(await getSetting(db(), c.orgId, "homeassistant.allow_resume"))) throw new ApiError(403, "Resuming agents from Home Assistant is switched off. Resume them in MOSS, or allow it under Settings > Modules > Home Assistant.");
      await setSetting(db(), c.orgId, "agents.kill_switch", false);
      await audit(c, "setting.update", "setting", "agents.kill_switch", { value: false });
      return { ok: true, message: "Agents may run again." };
    }
    case "POST agents/:id/pause": {
      await need(c, "agents.manage");
      await pauseAgent(db(), { orgId: c.orgId, userId: c.userId }, id!, "Paused from Home Assistant");
      return { ok: true };
    }
    case "POST agents/:id/resume": {
      await need(c, "agents.manage");
      if (!(await getSetting(db(), c.orgId, "homeassistant.allow_resume"))) throw new ApiError(403, "Resuming agents from Home Assistant is switched off.");
      await resumeAgent(db(), { orgId: c.orgId, userId: c.userId }, id!);
      return { ok: true };
    }

    // Maintenance mode: monitors keep checking, but nothing that goes down opens an incident until it ends.
    case "POST maintenance": {
      await need(c, "monitoring.manage");
      const { hours } = await body(req, z.object({ hours: z.number().min(0).max(24) }));
      const until = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : "";
      await setSetting(db(), c.orgId, "monitoring.quiet_until", until);
      await audit(c, "monitoring.maintenance", "setting", "monitoring.quiet_until", { hours });
      return { ok: true, quietUntil: until || null };
    }

    case "POST incidents": {
      await need(c, "incidents.manage");
      const f = await body(
        req,
        z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().max(5000).optional(),
          priority: z.enum(["P1", "P2", "P3", "P4"]).default("P3"),
          type: z.enum(["break_fix", "security", "request"]).default("break_fix"),
          agent: z.string().max(100).optional(),
        }),
      );
      const agent = f.agent ? await findAgent(c.orgId, f.agent) : null;
      const inc = await createIncident(
        db(),
        c.orgId,
        { type: f.type, title: f.title, description: f.description ? `${f.description}\n\n(Raised from Home Assistant.)` : "Raised from Home Assistant.", priority: f.priority, assignedAgentId: agent?.id ?? null },
        { type: "user", id: c.userId },
      );
      return { ok: true, id: inc.id, ref: incidentRef(inc.number) };
    }

    // "I've seen it": a comment that doesn't ask the agent for a reply.
    case "POST incidents/:id/acknowledge": {
      await need(c, "incidents.read");
      const [inc] = await db().select().from(incidents).where(and(eq(incidents.id, id!), eq(incidents.orgId, c.orgId)));
      if (!inc) throw new ApiError(404, "No such incident");
      await db().insert(incidentComments).values({ incidentId: inc.id, authorUserId: c.userId, body: "Acknowledged from Home Assistant." });
      await audit(c, "incident.acknowledge", "incident", inc.id);
      return { ok: true, ref: incidentRef(inc.number) };
    }

    case "POST monitors/:id/check": {
      await need(c, "monitoring.read");
      const [m] = await db().select({ id: monitors.id }).from(monitors).where(and(eq(monitors.id, id!), eq(monitors.orgId, c.orgId)));
      if (!m) throw new ApiError(404, "No such monitor");
      await checkMonitorNow(db(), c.orgId, m.id);
      return { ok: true };
    }

    case "POST tasks/:id/run": {
      await need(c, "agents.chat");
      const [s] = await db().select().from(agentSchedules).where(and(eq(agentSchedules.id, id!), eq(agentSchedules.orgId, c.orgId)));
      if (!s) throw new ApiError(404, "No such recurring task");
      await queueRun({ agentId: s.agentId, task: s.task, trigger: "schedule", triggerRef: s.id, requestedByUserId: c.userId });
      await audit(c, "agent.run_now", "agent", s.agentId, { task: s.task.slice(0, 200) });
      return { ok: true };
    }

    // Ask an agent something: it lands in the person's DM with the agent, and the answer is fetched below.
    case "POST ask": {
      await need(c, "agents.chat");
      const f = await body(req, z.object({ agent: z.string().min(1).max(100).default("Moss"), question: z.string().trim().min(1).max(4000) }));
      const agent = await findAgent(c.orgId, f.agent);
      const conversationId = await openDm(db(), c.orgId, c.userId, { type: "agent", id: agent.id });
      const { messageId } = await postMessage(db(), c.orgId, conversationId, { type: "user", id: c.userId }, f.question);
      const [msg] = await db().select({ at: conversationMessages.createdAt }).from(conversationMessages).where(eq(conversationMessages.id, messageId));
      await queueRun({ agentId: agent.id, trigger: "chat", triggerRef: conversationId, task: "Reply in chat", requestedByUserId: c.userId });
      await audit(c, "agent.chat", "conversation", conversationId, { agents: [agent.id], message: f.question.slice(0, 500) });
      return { ok: true, agent: agent.name, conversationId, since: msg!.at.toISOString() };
    }
    case "GET ask/:id": {
      await need(c, "agents.chat");
      const since = new Date(url.searchParams.get("since") ?? 0);
      const [reply] = await db()
        .select({ body: conversationMessages.body, status: conversationMessages.status, agentId: conversationMessages.authorAgentId })
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, id!), gt(conversationMessages.createdAt, since), sql`${conversationMessages.authorAgentId} is not null`))
        .orderBy(desc(conversationMessages.createdAt))
        .limit(1);
      return reply ? { done: true, reply: reply.body, status: reply.status ?? "succeeded" } : { done: false };
    }

    case "GET agents": {
      const rows = await db()
        .select({ id: agents.id, name: agents.name, title: agents.title })
        .from(agents)
        .where(and(eq(agents.orgId, c.orgId), ne(agents.status, "fired"), workingAgents))
        .orderBy(asc(agents.name));
      return { agents: rows };
    }
  }
  throw new ApiError(404, `Unknown endpoint ${method} /${path.join("/")}`);
}

async function respond(req: Request, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST") {
  try {
    const { path } = await ctx.params;
    return Response.json(await handle(req, path, method), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof ApiError) return Response.json({ error: err.message }, { status: err.status });
    return Response.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status: 400 });
  }
}

export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => respond(req, ctx, "GET");
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => respond(req, ctx, "POST");
