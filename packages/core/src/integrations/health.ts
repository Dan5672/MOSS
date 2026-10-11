// Integrations' health as monitors: each integration has its own monitor source (made on first use, never posted
// to from outside), and each thing it watches is an external monitor with its readings, so failures raise
// incidents and values can be graphed.
import { monitorSources, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { createMonitorSource, ingestAlerts } from "../services/monitors.js";
import { updateModuleState } from "../services/modules.js";
import type { IntegrationConfig, IntegrationDef, IntegrationState } from "./types.js";

/** The integration's monitor source, kept in step with its priority and responder. */
export async function ensureIntegrationSource(db: Database, orgId: string, def: IntegrationDef, c: IntegrationConfig, state: IntegrationState) {
  if (state.sourceId) {
    const [s] = await db.select().from(monitorSources).where(and(eq(monitorSources.id, state.sourceId), eq(monitorSources.orgId, orgId)));
    if (s) {
      if (s.defaultPriority !== c.priority || s.defaultResponderAgentId !== (c.responderAgentId ?? null) || !s.enabled) {
        await db
          .update(monitorSources)
          .set({ defaultPriority: c.priority, defaultResponderAgentId: c.responderAgentId ?? null, enabled: true, updatedAt: new Date() })
          .where(eq(monitorSources.id, s.id));
      }
      return { ...s, defaultPriority: c.priority, defaultResponderAgentId: c.responderAgentId ?? null, enabled: true };
    }
  }
  const { source } = await createMonitorSource(
    db,
    orgId,
    { name: def.name, kind: "generic", defaultPriority: c.priority, defaultResponderAgentId: c.responderAgentId ?? null },
    { type: "system", id: null },
  );
  await updateModuleState(db, orgId, def.key, { sourceId: source.id } satisfies IntegrationState);
  return source;
}

/** Records the integration's health checks on its monitors. */
export async function reportIntegrationHealth(db: Database, orgId: string, def: IntegrationDef, c: IntegrationConfig, state: IntegrationState, alerts: ParsedAlert[], now = new Date()) {
  if (!alerts.length) return { received: 0, applied: 0 };
  const source = await ensureIntegrationSource(db, orgId, def, c, state);
  return ingestAlerts(db, source, alerts.map((a) => ({ ...a, key: `${def.key}:${a.key}` })), now);
}

/** Stops its monitors raising anything while it's switched off. */
export async function pauseIntegrationSource(db: Database, orgId: string, state: IntegrationState) {
  if (state.sourceId) await db.update(monitorSources).set({ enabled: false, updatedAt: new Date() }).where(and(eq(monitorSources.id, state.sourceId), eq(monitorSources.orgId, orgId)));
}
