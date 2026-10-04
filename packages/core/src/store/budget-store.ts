// Budget status: compares recorded token usage against per-agent and global budgets.
import { budgets, tokenUsage, type Database } from "@moss/db";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";

export interface BudgetCheck {
  budgetId: string;
  scope: "agent" | "global";
  period: "day" | "month";
  unit: "tokens" | "usd";
  spent: number;
  softLimit: number | null;
  hardLimit: number;
}

export interface BudgetStatus {
  overSoft: boolean;
  overHard: boolean;
  checks: BudgetCheck[];
}

/** Start of the current budget period, in UTC. */
export function periodStart(period: "day" | "month", now = new Date()): Date {
  return period === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function evaluateBudgets(checks: BudgetCheck[]): BudgetStatus {
  return {
    checks,
    overHard: checks.some((c) => c.spent >= c.hardLimit),
    overSoft: checks.some((c) => c.softLimit !== null && c.spent >= c.softLimit),
  };
}

export async function getBudgetStatus(db: Database, orgId: string, agentId: string, now = new Date()): Promise<BudgetStatus> {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.orgId, orgId), or(eq(budgets.agentId, agentId), isNull(budgets.agentId))));

  const checks: BudgetCheck[] = [];
  for (const b of rows) {
    const scopeFilter = b.agentId ? eq(tokenUsage.agentId, b.agentId) : eq(tokenUsage.orgId, orgId);
    const [sum] = await db
      .select({
        tokens: sql<string>`coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens} + ${tokenUsage.cacheReadTokens} + ${tokenUsage.cacheWriteTokens}), 0)`,
        usd: sql<string>`coalesce(sum(${tokenUsage.costUsd}), 0)`,
      })
      .from(tokenUsage)
      .where(and(scopeFilter, gte(tokenUsage.createdAt, periodStart(b.period, now))));
    checks.push({
      budgetId: b.id,
      scope: b.agentId ? "agent" : "global",
      period: b.period,
      unit: b.unit,
      spent: Number(b.unit === "tokens" ? sum?.tokens : sum?.usd),
      softLimit: b.softLimit === null ? null : Number(b.softLimit),
      hardLimit: Number(b.hardLimit),
    });
  }
  return evaluateBudgets(checks);
}
