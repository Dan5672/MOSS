// Loads everything the policy needs for one tool call, straight from the database.
// Nothing here comes from the agent except the ids it supplied.
import { getBudgetStatus, getSetting } from "@moss/core";
import { agents, agentSkills, changeRequests, customToolGrants, customTools, networks, secretGrants, secrets, skills, type Database } from "@moss/db";
import type { PolicyContext, SecretPolicy } from "@moss/policy";
import { customToolSpecSchema } from "@moss/tools";
import { and, eq, inArray } from "drizzle-orm";

export type SecretRow = typeof secrets.$inferSelect;

export interface LoadedContext {
  orgId: string;
  siteId: string | null;
  policy: PolicyContext;
  /** Secret rows referenced by the call, keyed by name (only loaded, never decrypted here). */
  secretRows: Map<string, SecretRow>;
}

export async function loadAgent(db: Database, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  return agent;
}

/** Tools the agent may call: those its skills grant, plus enabled custom tools granted to it directly. */
export async function loadToolGrants(db: Database, agentId: string): Promise<Set<string>> {
  const [rows, custom] = await Promise.all([
    db
      .select({ toolGrants: skills.toolGrants })
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(eq(agentSkills.agentId, agentId)),
    db
      .select({ key: customTools.key })
      .from(customToolGrants)
      .innerJoin(customTools, eq(customTools.id, customToolGrants.toolId))
      .where(and(eq(customToolGrants.agentId, agentId), eq(customTools.enabled, true))),
  ]);
  return new Set([...rows.flatMap((r) => r.toolGrants), ...custom.map((c) => c.key)]);
}

/** An org's enabled custom tool by name, validated again on load (the stored spec is never trusted blindly). */
export async function loadCustomTool(db: Database, orgId: string, key: string) {
  const [row] = await db
    .select({ spec: customTools.spec })
    .from(customTools)
    .where(and(eq(customTools.orgId, orgId), eq(customTools.key, key), eq(customTools.enabled, true)));
  if (!row) return null;
  const parsed = customToolSpecSchema.safeParse(row.spec);
  return parsed.success ? parsed.data : null;
}

/** All of an org's enabled custom tools. */
export async function loadCustomTools(db: Database, orgId: string) {
  const rows = await db.select({ spec: customTools.spec }).from(customTools).where(and(eq(customTools.orgId, orgId), eq(customTools.enabled, true)));
  return rows.flatMap((r) => {
    const parsed = customToolSpecSchema.safeParse(r.spec);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function loadContext(
  db: Database,
  agent: typeof agents.$inferSelect,
  opts: { changeId?: string; secretNames: string[]; now?: Date },
): Promise<LoadedContext> {
  const orgId = agent.orgId;
  const [killSwitch, allowDangerous, budget, toolGrants, networkRows] = await Promise.all([
    getSetting(db, orgId, "agents.kill_switch"),
    getSetting(db, orgId, "tools.allow_dangerous"),
    getBudgetStatus(db, orgId, agent.id, opts.now),
    loadToolGrants(db, agent.id),
    db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, orgId)),
  ]);

  const secretRows = new Map<string, SecretRow>();
  const secretPolicies = new Map<string, SecretPolicy>();
  const granted = new Set<string>();
  if (opts.secretNames.length > 0) {
    const rows = await db
      .select()
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), inArray(secrets.name, opts.secretNames)));
    for (const row of rows) {
      secretRows.set(row.name, row);
      secretPolicies.set(row.name, { name: row.name, allowedHosts: row.allowedHosts, allowedTools: row.allowedTools });
    }
    if (rows.length > 0) {
      const grants = await db
        .select({ secretId: secretGrants.secretId })
        .from(secretGrants)
        .where(and(eq(secretGrants.agentId, agent.id), inArray(secretGrants.secretId, rows.map((r) => r.id))));
      const grantedIds = new Set(grants.map((g) => g.secretId));
      for (const row of rows) if (grantedIds.has(row.id)) granted.add(row.name);
    }
  }

  let change: PolicyContext["change"];
  if (opts.changeId) {
    const [cr] = await db
      .select()
      .from(changeRequests)
      .where(and(eq(changeRequests.id, opts.changeId), eq(changeRequests.orgId, orgId)));
    if (cr) {
      change = {
        id: cr.id,
        status: cr.status,
        windowStart: cr.windowStart,
        windowEnd: cr.windowEnd,
        plannedCalls: cr.plannedCalls,
        rollbackCalls: cr.rollbackCalls,
      };
    }
  }

  return {
    orgId,
    siteId: agent.siteId,
    secretRows,
    policy: {
      now: opts.now ?? new Date(),
      killSwitch,
      allowDangerousTools: allowDangerous,
      agent: { id: agent.id, status: agent.status, overBudget: budget.overHard, toolGrants, secretGrants: granted },
      networks: networkRows,
      secrets: secretPolicies,
      change,
    },
  };
}
