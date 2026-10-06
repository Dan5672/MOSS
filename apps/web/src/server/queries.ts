import "server-only";
import { getSetting, periodStart } from "@moss/core";
import { agentRuns, agents, assets, auditLog, budgets, changeRequests, incidents, models, monitors, providers, tokenUsage, users } from "@moss/db";
import { and, asc, count, desc, eq, gte, inArray, ne, sql, sum } from "drizzle-orm";
import { db } from "./db";

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
