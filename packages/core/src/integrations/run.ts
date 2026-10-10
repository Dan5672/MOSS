// Applying one run of an integration feature: its inventory and alerts, and a note of how it went for the
// integration's page. Shared by the worker's schedule and a person's Sync now.
import type { Database } from "@moss/db";
import { updateModuleState } from "../services/modules.js";
import { reportIntegrationHealth } from "./health.js";
import { applyIntegrationInventory } from "./inventory.js";
import type { FeatureOutput, IntegrationConfig, IntegrationDef, IntegrationFeature, IntegrationState } from "./types.js";

export type OpResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Whether a feature is due, from when it last ran. */
export function featureDue(state: IntegrationState, f: IntegrationFeature, now: Date): boolean {
  const at = state.runs?.[f.key]?.at;
  return !at || now.getTime() - Date.parse(at) >= f.everyMs;
}

export async function applyFeatureRun(
  db: Database,
  orgId: string,
  def: IntegrationDef,
  c: IntegrationConfig,
  state: IntegrationState,
  feature: IntegrationFeature,
  res: OpResult,
  now = new Date(),
): Promise<{ ok: boolean; summary: string }> {
  let out: FeatureOutput;
  if (res.ok) {
    try {
      out = feature.apply(res.result, { config: c, now });
    } catch (err) {
      out = { summary: `Couldn't read ${def.name}'s answer: ${(err as Error).message}` };
      res = { ok: false, error: out.summary! };
    }
  } else {
    // A health check that can't reach the product says so on its monitor; other features just note it.
    out = feature.key === "health" ? { alerts: [{ key: "reachable", name: def.name, status: "down", message: res.error.slice(0, 500) }] } : {};
  }
  const parts: string[] = [];
  if (out.inventory) {
    const r = await applyIntegrationInventory(db, orgId, def.key, out.inventory, now);
    parts.push(`${r.matched} matched, ${r.created} added${r.missing ? `, ${r.missing} gone` : ""}${r.locked ? `, ${r.locked} locked` : ""}`);
  }
  if (out.alerts?.length) await reportIntegrationHealth(db, orgId, def, c, state, out.alerts, now);
  const summary = res.ok ? (out.summary ?? (parts.join("; ") || "OK")) : res.error.slice(0, 300);
  await updateModuleState(db, orgId, def.key, { ...(out.state ?? {}), runs: { ...state.runs, [feature.key]: { at: now.toISOString(), ok: res.ok, summary } } } satisfies IntegrationState);
  return { ok: res.ok, summary };
}
