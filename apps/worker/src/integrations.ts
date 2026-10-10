// The integrations' background features (health checks, inventory syncs), each on its own schedule. The calls
// themselves go through the gate, which reads the config and holds the credentials.
import { applyFeatureRun, featureDue, INTEGRATIONS, integrationConfigured, integrationLicensed, loadIntegration, orgsWithModule, upsShutdownTick, type IntegrationState, type OpResult } from "@moss/core";
import type { Database } from "@moss/db";

export type IntegrationCaller = (orgId: string, key: string, op: string) => Promise<OpResult>;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

export function httpIntegrations(gateUrl: string, gateToken: string): IntegrationCaller {
  return async (orgId, key, op) => {
    try {
      const res = await fetch(`${gateUrl.replace(/\/+$/, "")}/v1/integrations/${encodeURIComponent(key)}/${encodeURIComponent(op)}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gateToken}` },
        body: JSON.stringify({ orgId }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
      if (!res.ok) return { ok: false, error: body.error ?? `The gate refused the call (HTTP ${res.status})` };
      return body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error ?? "Call failed" };
    } catch (err) {
      return { ok: false, error: `Gate unavailable: ${(err as Error).message}` };
    }
  };
}

/** One pass over every switched-on integration in every org. Each feature runs when due, and fails on its own. */
export async function runIntegrationsTick(db: Database, call: IntegrationCaller, opts: { now?: Date; log?: Log } = {}) {
  const now = opts.now ?? new Date();
  for (const def of INTEGRATIONS) {
    for (const orgId of await orgsWithModule(db, def.key)) {
      // A business integration stops (its settings kept) while there's no licence covering it.
      if (!(await integrationLicensed(db, orgId, def, now))) continue;
      const { config, state } = await loadIntegration(db, orgId, def);
      if (!integrationConfigured(def, config)) continue;
      let current: IntegrationState = state;
      for (const f of def.features) {
        if (!config.features[f.key] || !featureDue(current, f, now)) continue;
        try {
          const run = await applyFeatureRun(db, orgId, def, config, current, f, await call(orgId, def.key, f.key), now);
          current = { ...current, runs: { ...current.runs, [f.key]: { at: now.toISOString(), ...run } } };
          if (!run.ok) opts.log?.(`${def.name} ${f.label.toLowerCase()} failed`, { orgId, error: run.summary });
        } catch (err) {
          opts.log?.(`${def.name} ${f.label.toLowerCase()} failed`, { orgId, error: (err as Error).message });
        }
      }
    }
  }
  // The UPS shutdown plan, after the UPS readings are in.
  for (const orgId of await orgsWithModule(db, "nut")) {
    try {
      const did = await upsShutdownTick(db, orgId, now);
      if (did) opts.log?.(`UPS: ${did}`, { orgId });
    } catch (err) {
      opts.log?.("UPS shutdown plan failed", { orgId, error: (err as Error).message });
    }
  }
}
