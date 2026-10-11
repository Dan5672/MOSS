import "server-only";
import { agentToolGrants, getSetting, periodStart } from "@moss/core";
import { agentRuns, agents, assets, auditLog, budgets, changeRequests, incidents, models, monitors, networks, providers, tokenUsage, users } from "@moss/db";
import { and, asc, count, desc, eq, gte, inArray, ne, sql, sum } from "drizzle-orm";
import { db } from "./db";
import { workingAgents } from "@/server/people";

export async function dashboard(orgId: string) {
  const d = db();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [assetCounts, incidentRows, pendingChanges, agentRows, spendToday, spendMonth, recentRuns, recentAudit, monitorRows] = await Promise.all([
    d
      .select({ total: count(), recent: sql<number>`count(*) filter (where ${assets.firstSeenAt} >= ${weekAgo.toISOString()}::timestamptz)` })
      .from(assets)
      .where(and(eq(assets.orgId, orgId), ne(assets.status, "retired"))),
    d
      .select({ priority: incidents.priority, n: count() })
      .from(incidents)
      .where(and(eq(incidents.orgId, orgId), inArray(incidents.status, ["new", "in_progress", "on_hold"])))
      .groupBy(incidents.priority),
    d
      .select({ n: count() })
      .from(changeRequests)
      .where(and(eq(changeRequests.orgId, orgId), eq(changeRequests.status, "submitted"))),
    d
      .select({ status: agents.status, n: count() })
      .from(agents)
      .where(eq(agents.orgId, orgId))
      .groupBy(agents.status),
    d
      .select({ usd: sum(tokenUsage.costUsd) })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, periodStart("day")))),
    d
      .select({ usd: sum(tokenUsage.costUsd) })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, periodStart("month")))),
    d
      .select({ run: agentRuns, agentName: agents.name })
      .from(agentRuns)
      .innerJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(eq(agentRuns.orgId, orgId))
      .orderBy(desc(agentRuns.startedAt))
      .limit(8),
    d
      .select({ entry: auditLog, userName: users.displayName, agentName: agents.name })
      .from(auditLog)
      .leftJoin(users, sql`${users.id}::text = ${auditLog.actorId}`)
      .leftJoin(agents, sql`${agents.id}::text = ${auditLog.actorId}`)
      .where(eq(auditLog.orgId, orgId))
      .orderBy(desc(auditLog.id))
      .limit(12),
    d
      .select({ state: monitors.state, n: count() })
      .from(monitors)
      .where(eq(monitors.orgId, orgId))
      .groupBy(monitors.state),
  ]);
  const extra = await dashboardExtras(orgId);
  const monitorStates = Object.fromEntries(monitorRows.map((r) => [r.state, r.n])) as Record<string, number>;
  const byPriority = Object.fromEntries(incidentRows.map((r) => [r.priority, r.n])) as Record<string, number>;
  const byStatus = Object.fromEntries(agentRows.map((r) => [r.status, r.n])) as Record<string, number>;
  return {
    assets: { total: assetCounts[0]?.total ?? 0, newThisWeek: Number(assetCounts[0]?.recent ?? 0) },
    incidents: { byPriority, open: incidentRows.reduce((n, r) => n + r.n, 0) },
    pendingApprovals: pendingChanges[0]?.n ?? 0,
    agents: { active: byStatus.active ?? 0, paused: byStatus.paused ?? 0 },
    spend: { today: Number(spendToday[0]?.usd ?? 0), month: Number(spendMonth[0]?.usd ?? 0) },
    recentRuns,
    recentAudit: recentAudit.map(({ entry, userName, agentName }) => ({ ...entry, actorName: userName ?? agentName ?? null })),
    ...extra,
    monitors: { total: monitorRows.reduce((n, r) => n + r.n, 0), down: monitorStates.down ?? 0, degraded: monitorStates.degraded ?? 0, up: monitorStates.up ?? 0 },
  };
}

const PRIORITY_ORDER = sql`case ${incidents.priority} when 'P1' then 1 when 'P2' then 2 when 'P3' then 3 else 4 end`;

/** The dashboard's briefing, team cards and incident queue: a fixed set of grouped queries, not one per agent. */
async function dashboardExtras(orgId: string) {
  const d = db();
  const dayStart = periodStart("day");
  const monthStart = periodStart("month");
  const [killSwitch, oldestChange, openIncidents, team, lastRuns, budgetRows, usage] = await Promise.all([
    getSetting(d, orgId, "agents.kill_switch"),
    d
      .select({ id: changeRequests.id, number: changeRequests.number, title: changeRequests.title })
      .from(changeRequests)
      .where(and(eq(changeRequests.orgId, orgId), eq(changeRequests.status, "submitted")))
      .orderBy(asc(changeRequests.createdAt))
      .limit(1),
    d
      .select({ id: incidents.id, number: incidents.number, title: incidents.title, priority: incidents.priority, createdAt: incidents.createdAt, agentName: agents.name })
      .from(incidents)
      .leftJoin(agents, eq(agents.id, incidents.assignedAgentId))
      .where(and(eq(incidents.orgId, orgId), inArray(incidents.status, ["new", "in_progress", "on_hold"])))
      .orderBy(PRIORITY_ORDER, asc(incidents.createdAt))
      .limit(5),
    d
      .select({ agent: agents, modelName: models.displayName, providerName: providers.name })
      .from(agents)
      .leftJoin(models, eq(models.id, agents.modelId))
      .leftJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired")))
      .orderBy(agents.hiredAt),
    d
      .selectDistinctOn([agentRuns.agentId], { agentId: agentRuns.agentId, status: agentRuns.status, summary: agentRuns.summary, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(eq(agentRuns.orgId, orgId))
      .orderBy(agentRuns.agentId, desc(agentRuns.startedAt)),
    d.select().from(budgets).where(eq(budgets.orgId, orgId)),
    // Per-agent usage for both budget periods and both units, in one grouped query.
    d
      .select({
        agentId: tokenUsage.agentId,
        usdDay: sql<string>`coalesce(sum(${tokenUsage.costUsd}) filter (where ${tokenUsage.createdAt} >= ${dayStart.toISOString()}::timestamptz), 0)`,
        usdMonth: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
        tokensDay: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens}) filter (where ${tokenUsage.createdAt} >= ${dayStart.toISOString()}::timestamptz), 0)`,
        tokensMonth: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens}), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, monthStart)))
      .groupBy(tokenUsage.agentId),
  ]);

  const spentFor = (agentId: string, b: { period: "day" | "month"; unit: "tokens" | "usd" }) => {
    const u = usage.find((r) => r.agentId === agentId);
    if (!u) return 0;
    return Number(b.unit === "usd" ? (b.period === "day" ? u.usdDay : u.usdMonth) : b.period === "day" ? u.tokensDay : u.tokensMonth);
  };
  const orgCap = budgetRows.find((b) => b.agentId === null && b.period === "month" && b.unit === "usd");

  return {
    killSwitch,
    oldestPendingChange: oldestChange[0] ?? null,
    openIncidentQueue: openIncidents,
    /** The org-wide monthly dollar cap, if one is set. */
    monthlyCapUsd: orgCap ? Number(orgCap.hardLimit) : null,
    team: team.map(({ agent, modelName, providerName }) => {
      const last = lastRuns.find((r) => r.agentId === agent.id);
      // The agent's budget closest to its limit, if it has any.
      const budget =
        budgetRows
          .filter((b) => b.agentId === agent.id)
          .map((b) => ({ period: b.period, unit: b.unit, limit: Number(b.hardLimit), spent: spentFor(agent.id, b) }))
          .sort((a, b) => b.spent / b.limit - a.spent / a.limit)[0] ?? null;
      return {
        id: agent.id,
        name: agent.name,
        title: agent.title,
        templateKey: agent.templateKey,
        mascot: agent.mascot,
        mascotGlow: agent.mascotGlow,
        status: agent.status,
        modelName,
        providerName,
        lastRun: last ? { status: last.status, summary: last.summary, startedAt: last.startedAt } : null,
        budget,
      };
    }),
  };
}

/**
 * The Basement page: who's working (has a running run), who's on break, down monitors, and who is
 * responding to the first one. Fired agents aren't included.
 */
export async function basement(orgId: string) {
  const d = db();
  const [team, running, down] = await Promise.all([
    d
      .select({ id: agents.id, name: agents.name, title: agents.title, templateKey: agents.templateKey, mascot: agents.mascot, mascotGlow: agents.mascotGlow })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired")))
      .orderBy(agents.hiredAt),
    d
      .selectDistinctOn([agentRuns.agentId], { agentId: agentRuns.agentId, trigger: agentRuns.trigger, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
      .orderBy(agentRuns.agentId, desc(agentRuns.startedAt)),
    d
      .select({ id: monitors.id, name: monitors.name, openIncidentId: monitors.openIncidentId })
      .from(monitors)
      .where(and(eq(monitors.orgId, orgId), eq(monitors.state, "down")))
      .orderBy(asc(monitors.stateChangedAt)),
  ]);
  // The responder: whoever is assigned to the first down monitor's open incident, else the IT Manager,
  // else any agent.
  let responderId: string | null = null;
  const first = down[0];
  if (first) {
    if (first.openIncidentId) {
      const [inc] = await d.select({ agentId: incidents.assignedAgentId }).from(incidents).where(eq(incidents.id, first.openIncidentId));
      if (inc?.agentId && team.some((a) => a.id === inc.agentId)) responderId = inc.agentId;
    }
    responderId ??= team.find((a) => a.templateKey === "it-manager")?.id ?? team[0]?.id ?? null;
  }
  return {
    team: team.map((a) => {
      const run = running.find((r) => r.agentId === a.id);
      return { ...a, working: !!run, trigger: run?.trigger ?? null, since: run?.startedAt ?? null };
    }),
    down: down.map((m) => ({ id: m.id, name: m.name })),
    responderId,
  };
}

/**
 * The dashboard's "Getting started" checklist: what's set up, and which agent could run a first network
 * discovery (an active agent that may use nmap_scan, preferring a Network Admin).
 */
export async function setupProgress(orgId: string) {
  const d = db();
  const [[modelCount], [allowed], [monitorCount], [assetCount], active] = await Promise.all([
    d.select({ n: count() }).from(models).where(and(eq(models.orgId, orgId), eq(models.enabled, true))),
    d.select({ n: count() }).from(networks).where(and(eq(networks.orgId, orgId), eq(networks.status, "allowed"))),
    d.select({ n: count() }).from(monitors).where(eq(monitors.orgId, orgId)),
    d.select({ n: count() }).from(assets).where(eq(assets.orgId, orgId)),
    d
      .select({ id: agents.id, name: agents.name, templateKey: agents.templateKey })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.status, "active")))
      .orderBy(agents.hiredAt),
  ]);
  const ordered = [...active].sort((a, b) => Number(b.templateKey === "network-admin") - Number(a.templateKey === "network-admin"));
  let discoveryAgent: { id: string; name: string } | null = null;
  for (const a of ordered) {
    if ((await agentToolGrants(d, a.id)).has("nmap_scan")) {
      discoveryAgent = { id: a.id, name: a.name };
      break;
    }
  }
  // Moss is hired automatically, so it doesn't count as having hired an agent.
  const [anyAgent] = await d.select({ n: count() }).from(agents).where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"), workingAgents));
  return {
    hasModel: (modelCount?.n ?? 0) > 0,
    hasAllowedNetwork: (allowed?.n ?? 0) > 0,
    hasAgent: (anyAgent?.n ?? 0) > 0,
    hasAssets: (assetCount?.n ?? 0) > 0,
    hasMonitor: (monitorCount?.n ?? 0) > 0,
    discoveryAgent,
  };
}

export async function agentList(orgId: string) {
  const monthStart = periodStart("month");
  const rows = await db()
    .select({ agent: agents, modelName: models.displayName })
    .from(agents)
    .leftJoin(models, eq(agents.modelId, models.id))
    .where(eq(agents.orgId, orgId))
    .orderBy(agents.hiredAt);
  const spend = await db()
    .select({ agentId: tokenUsage.agentId, usd: sum(tokenUsage.costUsd), tokens: sql<string>`sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens})` })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, monthStart)))
    .groupBy(tokenUsage.agentId);
  const lastRuns = await db()
    .selectDistinctOn([agentRuns.agentId], { agentId: agentRuns.agentId, status: agentRuns.status, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(agentRuns.agentId, desc(agentRuns.startedAt));
  return rows.map(({ agent, modelName }) => {
    const s = spend.find((x) => x.agentId === agent.id);
    return {
      ...agent,
      modelName,
      monthUsd: Number(s?.usd ?? 0),
      monthTokens: Number(s?.tokens ?? 0),
      lastRun: lastRuns.find((r) => r.agentId === agent.id) ?? null,
    };
  });
}

/** Token use and cost: today, this month, the last 30 days by day, and this month by agent and by model. */
export async function tokenSpend(orgId: string) {
  const d = db();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = new Date(Date.now() - 29 * 86_400_000);
  since.setHours(0, 0, 0, 0);
  const totals = (from: Date) =>
    d
      .select({
        input: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens}), 0)`,
        output: sql<string>`coalesce(sum(${tokenUsage.outputTokens}), 0)`,
        usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, from)));
  const [[today], [month], daily, byAgent, byModel] = await Promise.all([
    totals(periodStart("day")),
    totals(periodStart("month")),
    d
      .select({
        // Days in MOSS's own time zone (TZ), like everything else on screen, not the database's.
        day: sql<string>`to_char(${tokenUsage.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`,
        tokens: sql<string>`sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens})`,
        usd: sql<string>`sum(${tokenUsage.costUsd})`,
      })
      .from(tokenUsage)
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, since)))
      .groupBy(sql`1`),
    d
      .select({ name: agents.name, tokens: sql<string>`sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens})`, usd: sql<string>`sum(${tokenUsage.costUsd})` })
      .from(tokenUsage)
      .innerJoin(agents, eq(agents.id, tokenUsage.agentId))
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, periodStart("month"))))
      .groupBy(agents.name)
      .orderBy(desc(sql`sum(${tokenUsage.costUsd})`)),
    d
      .select({ name: models.displayName, tokens: sql<string>`sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens})`, usd: sql<string>`sum(${tokenUsage.costUsd})` })
      .from(tokenUsage)
      .innerJoin(models, eq(models.id, tokenUsage.modelId))
      .where(and(eq(tokenUsage.orgId, orgId), gte(tokenUsage.createdAt, periodStart("month"))))
      .groupBy(models.displayName)
      .orderBy(desc(sql`sum(${tokenUsage.costUsd})`)),
  ]);
  // Every one of the last 30 days, including the quiet ones.
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(since.getTime() + i * 86_400_000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const row = daily.find((r) => r.day === key);
    return { day: key, tokens: Number(row?.tokens ?? 0), usd: Number(row?.usd ?? 0) };
  });
  const num = (r?: { input: string; output: string; usd: string }) => ({ input: Number(r?.input ?? 0), output: Number(r?.output ?? 0), usd: Number(r?.usd ?? 0) });
  const rows = (list: { name: string; tokens: string; usd: string }[]) => list.map((r) => ({ name: r.name, tokens: Number(r.tokens), usd: Number(r.usd) }));
  return { today: num(today), month: num(month), days, byAgent: rows(byAgent), byModel: rows(byModel) };
}
