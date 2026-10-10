import "server-only";
import { getIntegration, loadIntegration, type IntegrationDef } from "@moss/core";
import { agents, monitors, secrets } from "@moss/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { config } from "./config";
import { db } from "./db";
import { workingAgents } from "./people";

/** A person's integration call through the gate (Test connection, Sync now); the gate re-checks their permission. */
export async function integrationCall(userId: string, key: string, op: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${config.gateUrl()}/v1/web/integrations/${encodeURIComponent(key)}/${encodeURIComponent(op)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.webToken()}` },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `The gate refused the call (HTTP ${res.status})` };
    return body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error ?? "The call failed" };
  } catch (err) {
    return { ok: false, error: `The gate is unavailable: ${(err as Error).message}` };
  }
}

/** Everything an integration's page shows. */
export async function integrationPage(orgId: string, def: IntegrationDef) {
  const [it, credential, agentRows, monitorRows] = await Promise.all([
    loadIntegration(db(), orgId, def),
    db()
      .select({ allowedHosts: secrets.allowedHosts, updatedAt: secrets.updatedAt })
      .from(secrets)
      .where(and(eq(secrets.orgId, orgId), eq(secrets.name, def.credential.secretName))),
    db()
      .select({ id: agents.id, name: agents.name, title: agents.title })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), ne(agents.status, "fired"), workingAgents))
      .orderBy(asc(agents.hiredAt)),
    db().select({ id: monitors.id, name: monitors.name, state: monitors.state, sourceId: monitors.sourceId }).from(monitors).where(eq(monitors.orgId, orgId)),
  ]);
  return {
    ...it,
    credential: credential[0] ?? null,
    agents: agentRows,
    monitors: it.state.sourceId ? monitorRows.filter((m) => m.sourceId === it.state.sourceId) : [],
  };
}

export function integrationOrNull(key: string) {
  return getIntegration(key);
}
