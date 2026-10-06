import "server-only";
import { PLATFORM_TOOLS } from "@moss/agent";
import { agents, agentRuns, agentSkills, agentToolOverrides, customToolGrants, customTools, rolePermissions, runSteps, skills } from "@moss/db";
import { BUILT_IN_TOOLS, customToolSpecSchema } from "@moss/tools";
import { and, eq, gte, inArray, max, ne, sql } from "drizzle-orm";
import { db } from "./db";

export interface CatalogTool {
  name: string;
  description: string;
  /** "network": runs in the toolbox through the policy gate; "moss": works on MOSS's own records; "custom": uploaded. */
  source: "network" | "moss" | "custom";
  /** Write tools change something: network writes need an approved change request. */
  kind: "read" | "write";
}

/** Every tool an agent can be given, built-in network tools first. */
export function toolCatalog(): CatalogTool[] {
  return [
    ...[...BUILT_IN_TOOLS.values()].map((t) => ({
      name: t.manifest.name,
      description: t.description,
      source: "network" as const,
      kind: t.manifest.class === "read" ? ("read" as const) : ("write" as const),
    })),
    ...PLATFORM_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      source: "moss" as const,
      kind: t.permission.endsWith(".read") ? ("read" as const) : ("write" as const),
    })),
  ];
}

const PLATFORM_PERMISSION = new Map(PLATFORM_TOOLS.map((t) => [t.name, t.permission]));

/** How one agent stands with one tool. */
export interface ToolHolding {
  id: string;
  name: string;
  status: string;
  /** Effective access: the rule in @moss/core agentToolGrants, plus the role permission for MOSS tools. */
  access: boolean;
  /** What the agent's skills (or, for custom tools, a direct grant) give, before any override. */
  base: boolean;
  via: string[];
  override: "granted" | "removed" | null;
  /** A MOSS tool the agent is granted but whose permission its role lacks. */
  blockedByRole: boolean;
}

/**
 * Which agents can use which tools, and how much they use them. Mirrors agentToolGrants (skills + direct
 * custom grants + per-agent overrides) and the runtime's role-permission check for MOSS tools.
 */
export async function toolAccess(orgId: string, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [agentRows, grants, usage, customRows, customGrants, overrides] = await Promise.all([
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title, status: agents.status, roleId: agents.roleId })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired")))
      .orderBy(agents.hiredAt),
    db()
      .select({ agentId: agentSkills.agentId, skill: skills.name, tools: skills.toolGrants })
      .from(agentSkills)
      .innerJoin(skills, eq(skills.id, agentSkills.skillId))
      .innerJoin(agents, eq(agents.id, agentSkills.agentId))
      .where(eq(agents.orgId, orgId)),
    // Tool calls and policy denials per agent and tool, from the recorded run steps.
    db()
      .select({
        agentId: agentRuns.agentId,
        tool: sql<string>`${runSteps.content}->>'name'`,
        calls: sql<number>`count(*) filter (where ${runSteps.kind} = 'tool_call')`.mapWith(Number),
        denied: sql<number>`count(*) filter (where ${runSteps.kind} = 'policy_denied')`.mapWith(Number),
        lastUsed: max(runSteps.createdAt),
      })
      .from(runSteps)
      .innerJoin(agentRuns, eq(agentRuns.id, runSteps.runId))
      .where(and(eq(agentRuns.orgId, orgId), inArray(runSteps.kind, ["tool_call", "policy_denied"]), gte(runSteps.createdAt, since)))
      .groupBy(agentRuns.agentId, sql`${runSteps.content}->>'name'`),
    db().select().from(customTools).where(eq(customTools.orgId, orgId)),
    db()
      .select({ toolId: customToolGrants.toolId, agentId: customToolGrants.agentId })
      .from(customToolGrants)
      .innerJoin(customTools, eq(customTools.id, customToolGrants.toolId))
      .where(eq(customTools.orgId, orgId)),
    db()
      .select({ agentId: agentToolOverrides.agentId, tool: agentToolOverrides.tool, granted: agentToolOverrides.granted })
      .from(agentToolOverrides)
      .innerJoin(agents, eq(agents.id, agentToolOverrides.agentId))
      .where(eq(agents.orgId, orgId)),
  ]);
  const roleIds = [...new Set(agentRows.map((a) => a.roleId).filter((r): r is string => !!r))];
  const rolePerms = roleIds.length
    ? await db().select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const permsOf = (roleId: string | null) => new Set(rolePerms.filter((p) => p.roleId === roleId).map((p) => p.permission));

  // Custom tools reach agents through a direct grant rather than a skill.
  const custom = customRows.flatMap((row) => {
    const spec = customToolSpecSchema.safeParse(row.spec);
    if (!spec.success) return [];
    return [{ id: row.id, enabled: row.enabled, tool: { name: row.key, description: spec.data.description, source: "custom" as const, kind: spec.data.class } }];
  });
  const catalog = [...toolCatalog(), ...custom.map((c) => c.tool)];
  const tools = catalog.map((tool) => {
    const customRow = custom.find((c) => c.tool.name === tool.name && tool.source === "custom");
    const holdings: ToolHolding[] = agentRows.map((a) => {
      const via = customRow
        ? customGrants.some((g) => g.toolId === customRow.id && g.agentId === a.id) && customRow.enabled
          ? ["a direct grant"]
          : []
        : grants.filter((g) => g.agentId === a.id && g.tools.includes(tool.name)).map((g) => g.skill);
      const o = overrides.find((x) => x.agentId === a.id && x.tool === tool.name);
      const granted = o ? o.granted : via.length > 0;
      const permission = PLATFORM_PERMISSION.get(tool.name);
      const blockedByRole = granted && !!permission && !permsOf(a.roleId).has(permission);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        access: granted && !blockedByRole && (!customRow || customRow.enabled),
        base: via.length > 0,
        via,
        override: o ? (o.granted ? "granted" : "removed") : null,
        blockedByRole,
      };
    });
    const holders = holdings.filter((h) => h.access).map((h) => ({ ...h, via: h.override === "granted" ? ["a grant on this page"] : h.via }));
    const used = usage.filter((u) => u.tool === tool.name);
    return {
      ...tool,
      holders,
      holdings,
      calls: used.reduce((n, u) => n + u.calls, 0),
      denied: used.reduce((n, u) => n + u.denied, 0),
      lastUsed: used.reduce<Date | null>((d, u) => (u.lastUsed && (!d || u.lastUsed > d) ? u.lastUsed : d), null),
    };
  });
  return { agents: agentRows, tools, sinceDays };
}

/** The most recent policy denials: a tool call the gate or runtime refused. */
export async function recentDenials(orgId: string, limit = 15) {
  return db()
    .select({
      at: runSteps.createdAt,
      runId: runSteps.runId,
      tool: sql<string>`${runSteps.content}->>'name'`,
      code: sql<string>`${runSteps.content}->>'code'`,
      reason: sql<string>`${runSteps.content}->>'reason'`,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(runSteps)
    .innerJoin(agentRuns, eq(agentRuns.id, runSteps.runId))
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.orgId, orgId), eq(runSteps.kind, "policy_denied")))
    .orderBy(sql`${runSteps.createdAt} desc`)
    .limit(limit);
}

