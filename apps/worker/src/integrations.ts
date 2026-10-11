// The integrations' background features (health checks, inventory syncs), each on its own schedule. The calls
// themselves go through the gate, which reads the config and holds the credentials.
import {
  addIncidentComment,
  applyFeatureRun,
  featureDue,
  getIntegration,
  INTEGRATIONS,
  integrationConfigured,
  integrationLicensed,
  loadIntegration,
  notePagerdutyChanges,
  orgsWithModule,
  pagerdutyEventArgs,
  pagerdutyPages,
  upsShutdownTick,
  type IntegrationState,
  type OpResult,
} from "@moss/core";
import { incidents, type Database } from "@moss/db";
import { eq } from "drizzle-orm";

export type IntegrationCaller = (orgId: string, key: string, op: string, args?: Record<string, unknown>) => Promise<OpResult>;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

export function httpIntegrations(gateUrl: string, gateToken: string): IntegrationCaller {
  return async (orgId, key, op, args) => {
    try {
      const res = await fetch(`${gateUrl.replace(/\/+$/, "")}/v1/integrations/${encodeURIComponent(key)}/${encodeURIComponent(op)}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gateToken}` },
        body: JSON.stringify({ orgId, ...(args ? { args } : {}) }),
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
  // PagerDuty: note who acknowledged or resolved each page, after the acknowledgements feature has read them.
  for (const orgId of await orgsWithModule(db, "pagerduty")) {
    try {
      if (!(await integrationLicensed(db, orgId, PAGERDUTY_DEF(), now))) continue;
      const n = await notePagerdutyChanges(db, orgId);
      if (n) opts.log?.("PagerDuty acknowledgements noted", { orgId, n });
    } catch (err) {
      opts.log?.("PagerDuty acknowledgements failed", { orgId, error: (err as Error).message });
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

const PAGERDUTY_DEF = () => getIntegration("pagerduty")!;

/**
 * Pages PagerDuty for a new MOSS incident at a priority that pages, or stands the page down when it's resolved.
 * The incident says whether paging worked, so nobody assumes the on-call person knows when they don't.
 */
export async function pagerdutyIncident(db: Database, call: IntegrationCaller, incidentId: string, action: "trigger" | "resolve", log?: Log) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) return;
  const def = PAGERDUTY_DEF();
  if (!(await integrationLicensed(db, inc.orgId, def))) return;
  const { enabled, config } = await loadIntegration(db, inc.orgId, def);
  if (!enabled || !pagerdutyPages(config, inc.priority)) return;
  const res = await call(inc.orgId, "pagerduty", "event", pagerdutyEventArgs(inc, action));
  const system = { type: "system" as const, id: null };
  if (!res.ok) {
    log?.("PagerDuty event failed", { orgId: inc.orgId, action, error: res.error });
    if (action === "trigger") await addIncidentComment(db, inc.orgId, inc.id, `Couldn't page PagerDuty: ${res.error}`.slice(0, 1000), system);
    return;
  }
  if (action === "trigger") await addIncidentComment(db, inc.orgId, inc.id, "Paged the on-call person in PagerDuty.", system);
}
