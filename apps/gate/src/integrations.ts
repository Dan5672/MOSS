// Calls MOSS makes for an integration (Pi-hole, Proxmox...): its health checks and inventory syncs from the worker,
// and Test connection / Sync now from its settings page. The caller only names the org, the integration and the
// operation; the gate reads the integration's config, checks it's on (and the feature for that operation), builds
// the arguments, and makes the call under the same rules as agents' calls.
import { getIntegration, integrationArgs, loadIntegration, writeAudit } from "@moss/core";
import { systemToolCall, type SystemCallDeps } from "./system-call.js";

export type IntegrationOpResult = { ok: true; result: unknown } | { ok: false; error: string };

/** "test" works before it's switched on; "sync:<feature>" is a person's Sync now, allowed while it's on. */
export async function runIntegrationOp(
  deps: SystemCallDeps,
  req: { orgId: string; key: string; op: string; args?: Record<string, unknown>; userId?: string },
): Promise<IntegrationOpResult> {
  const def = getIntegration(req.key);
  if (!def) return { ok: false, error: "Unknown integration" };
  const manual = req.op.startsWith("sync:");
  const feature = manual ? def.features.find((f) => f.key === req.op.slice(5)) : def.features.find((f) => f.op === req.op);
  const opName = req.op === "test" ? def.test.op : manual ? feature?.op : req.op;
  const op = opName ? def.ops[opName] : undefined;
  if (!op) return { ok: false, error: "Unknown operation" };

  const audit = (ok: boolean, details: Record<string, unknown>) =>
    writeAudit(deps.db, {
      orgId: req.orgId,
      actorType: req.userId ? "user" : "system",
      actorId: req.userId ?? null,
      action: ok ? "module.call" : "module.call_failed",
      targetType: "module",
      targetId: def.key,
      details: { op: req.op, tool: op.tool, ...details },
    });

  const { enabled, config } = await loadIntegration(deps.db, req.orgId, def);
  if (req.op !== "test") {
    if (!enabled) return { ok: false, error: `The ${def.name} integration is switched off` };
    if (!manual && feature && !config.features[feature.key]) return { ok: false, error: `${feature.label} is switched off` };
    if (manual && !feature) return { ok: false, error: "Unknown feature" };
  }
  if (!config.host) return { ok: false, error: `Set ${def.name}'s address first` };

  const res = await systemToolCall(deps, {
    orgId: req.orgId,
    tool: op.tool,
    args: { ...integrationArgs(def, config), ...op.args?.(config), ...req.args },
    secret: { name: def.credential.secretName, arg: def.credential.arg },
    label: def.name,
  });
  if (!res.ok) {
    await audit(false, { error: res.error });
    return { ok: false, error: res.error };
  }
  // Routine background reads aren't audited when they work; people's calls are.
  if (req.userId) await audit(true, { args: res.args });
  return { ok: true, result: res.result };
}
