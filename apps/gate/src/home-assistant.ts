// Calls MOSS makes to Home Assistant for the Home Assistant module (health checks, inventory sync,
// notifications, its own sensors). There is no agent: the caller only names an org and an operation.
// The gate reads the module's config itself, checks the operation's feature is on, applies the same
// network scope as agent calls and the token secret's own host and tool scope, then decrypts the token.
import { HA_TOKEN_SECRET, userPermissions, haConnectionArgs, loadHomeAssistant, writeAudit, type HaConfig } from "@moss/core";
import { users, type Database } from "@moss/db";
import { eq } from "drizzle-orm";
import { systemToolCall } from "./system-call.js";
import type { ToolboxClient } from "./toolbox-client.js";

export const HA_OPS = ["test", "health", "devices", "notify", "publish", "state"] as const;
export type HaOp = (typeof HA_OPS)[number];

const TOOL_FOR: Record<HaOp, string> = {
  test: "homeassistant_health",
  health: "homeassistant_health",
  devices: "homeassistant_devices",
  notify: "homeassistant_notify",
  publish: "homeassistant_publish",
  // One entity's state, for Home Assistant sensor monitors.
  state: "homeassistant_states",
};

/** Successful routine reads and sensor updates run every few minutes; only these aren't audited when they succeed. */
const QUIET_WHEN_OK = new Set<HaOp>(["health", "publish", "devices", "state"]);

/** The org of an active user who may manage modules; null for anyone else. Guards a person's module calls. */
export async function moduleManagerOrg(db: Database, userId: string): Promise<string | null> {
  const [u] = await db.select({ orgId: users.orgId, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u || u.status !== "active") return null;
  return (await userPermissions(db, userId)).has("integrations.manage") ? u.orgId : null;
}

export type HaOpResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Why an operation may not run now, or null. "test" works before the module is switched on. */
function refusal(op: HaOp, enabled: boolean, c: HaConfig, args: Record<string, unknown>): string | null {
  if (op === "test") return null;
  if (!enabled) return "The Home Assistant module is switched off";
  if (op === "health" && !c.health.enabled) return "Health checks are switched off";
  if (op === "devices" && !c.inventory.enabled) return "Inventory sync is switched off";
  if (op === "publish" && !c.sensors.enabled) return "Status sensors are switched off";
  if (op === "notify") {
    if (!c.notify.enabled) return "Phone notifications are switched off";
    if (!c.notify.services.includes(String(args.service))) return `notify.${String(args.service)} isn't one of the module's notify services`;
  }
  return null;
}

export async function runHomeAssistantOp(
  deps: { db: Database; masterKey: Buffer; toolbox: ToolboxClient },
  req: { orgId: string; op: HaOp; args?: Record<string, unknown>; userId?: string },
): Promise<HaOpResult> {
  const tool = TOOL_FOR[req.op];
  const audit = (ok: boolean, details: Record<string, unknown>) =>
    writeAudit(deps.db, {
      orgId: req.orgId,
      actorType: req.userId ? "user" : "system",
      actorId: req.userId ?? null,
      action: ok ? "module.call" : "module.call_failed",
      targetType: "module",
      targetId: "home_assistant",
      details: { op: req.op, tool, ...details },
    });
  const fail = async (error: string) => {
    await audit(false, { error });
    return { ok: false as const, error };
  };

  const ha = await loadHomeAssistant(deps.db, req.orgId);
  const opArgs = req.args ?? {};
  const refused = refusal(req.op, ha.enabled, ha.config, opArgs);
  if (refused) return fail(refused);
  if (!ha.config.host) return fail("Set Home Assistant's address first");

  const res = await systemToolCall(deps, {
    orgId: req.orgId,
    tool,
    args: { ...haConnectionArgs(ha.config), ...opArgs },
    secret: { name: HA_TOKEN_SECRET, arg: "token" },
    label: "Home Assistant",
  });
  if (!res.ok) return fail(res.error.replace("Add Home Assistant's credential first", "Add Home Assistant's access token first"));
  if (!QUIET_WHEN_OK.has(req.op)) await audit(true, { args: res.args });
  return { ok: true, result: res.result };
}
