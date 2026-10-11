import "server-only";
import { PLATFORM_TOOLS } from "@moss/agent";
import { HA_SELF_HEAL_TEMPLATE, HA_TOKEN_SECRET, loadHomeAssistant, type HaConfig } from "@moss/core";
import { agents, agentSchedules, monitors, monitorSources, rolePermissions, secrets, standardChangeTemplates } from "@moss/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { workingAgents } from "@/server/people";

/** Everything the module page shows. */
export async function homeAssistantPage(orgId: string) {
  const ha = await loadHomeAssistant(db(), orgId);
  const c = ha.config;
  const [token, source, agentRows, monitorRows, schedule, template] = await Promise.all([
    db().select({ allowedHosts: secrets.allowedHosts, lastRotatedAt: secrets.lastRotatedAt }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, HA_TOKEN_SECRET))),
    c.sourceId ? db().select().from(monitorSources).where(and(eq(monitorSources.id, c.sourceId), eq(monitorSources.orgId, orgId))) : Promise.resolve([]),
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title, roleId: agents.roleId, status: agents.status })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"), workingAgents))
      .orderBy(asc(agents.hiredAt)),
    db().select({ id: monitors.id, name: monitors.name, state: monitors.state }).from(monitors).where(eq(monitors.orgId, orgId)).orderBy(asc(monitors.name)),
    c.logReview.scheduleId ? db().select().from(agentSchedules).where(eq(agentSchedules.id, c.logReview.scheduleId)) : Promise.resolve([]),
    db().select({ enabled: standardChangeTemplates.enabled }).from(standardChangeTemplates).where(and(eq(standardChangeTemplates.orgId, orgId), eq(standardChangeTemplates.key, HA_SELF_HEAL_TEMPLATE))),
  ]);
  return {
    ...ha,
    token: token[0] ?? null,
    source: source[0] ?? null,
    agents: agentRows,
    monitors: monitorRows,
    schedule: schedule[0] ?? null,
    templateEnabled: template[0]?.enabled ?? false,
  };
}

const PLATFORM_PERMISSION = new Map<string, string>(PLATFORM_TOOLS.map((t) => [t.name, t.permission]));

/** MOSS tools in `tools` the agent's role doesn't allow: granted, they still can't be used. */
export async function blockedByRole(roleId: string | null, tools: string[]): Promise<string[]> {
  const perms = roleId ? new Set((await db().select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId))).map((r) => r.p)) : new Set<string>();
  return tools.filter((t) => {
    const needed = PLATFORM_PERMISSION.get(t);
    return needed && !perms.has(needed);
  });
}

export type HaWebOp = "test" | "devices";

/** A person's Home Assistant call through the gate (it re-checks their permission and the module's config). */
export async function homeAssistantCall(userId: string, op: HaWebOp): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const res = await fetch(`${config.gateUrl()}/v1/web/modules/home-assistant/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken()}` },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
  if (!res.ok) return { ok: false, error: body.error ?? `The gate refused the call (HTTP ${res.status})` };
  return body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error ?? "Home Assistant call failed" };
}

export type { HaConfig };
