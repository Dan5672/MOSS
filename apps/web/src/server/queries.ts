import "server-only";
import { periodStart } from "@moss/core";
import { agentRuns, agents, assets, auditLog, changeRequests, incidents, models, monitors, tokenUsage } from "@moss/db";
import { and, count, desc, eq, gte, inArray, ne, sql, sum } from "drizzle-orm";
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
    d.select().from(auditLog).where(eq(auditLog.orgId, orgId)).orderBy(desc(auditLog.id)).limit(10),
    d
      .select({ state: monitors.state, n: count() })
      .from(monitors)
      .where(eq(monitors.orgId, orgId))
      .groupBy(monitors.state),
  ]);
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
    recentAudit,
    monitors: { total: monitorRows.reduce((n, r) => n + r.n, 0), down: monitorStates.down ?? 0, degraded: monitorStates.degraded ?? 0, up: monitorStates.up ?? 0 },
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
