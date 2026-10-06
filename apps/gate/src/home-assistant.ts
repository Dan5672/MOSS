// Calls MOSS makes to Home Assistant for the Home Assistant module (health checks, inventory sync,
// notifications, its own sensors). There is no agent: the caller only names an org and an operation.
// The gate reads the module's config itself, checks the operation's feature is on, applies the same
// network scope as agent calls and the token secret's own host and tool scope, then decrypts the token.
import { decryptSecret, HA_TOKEN_SECRET, userPermissions, haConnectionArgs, loadHomeAssistant, redactSecrets, writeAudit, type HaConfig } from "@moss/core";
import { networks, secrets, users, type Database } from "@moss/db";
import { checkScope, contains, parseRange, type IpRange } from "@moss/policy";
import { BUILT_IN_TOOLS, parseToolArgs, SYSTEM_TOOLS } from "@moss/tools";
import { and, eq } from "drizzle-orm";
import type { ToolboxClient } from "./toolbox-client.js";

export const HA_OPS = ["test", "health", "devices", "notify", "publish"] as const;
export type HaOp = (typeof HA_OPS)[number];

const TOOL_FOR: Record<HaOp, string> = {
  test: "homeassistant_health",
  health: "homeassistant_health",
  devices: "homeassistant_devices",
  notify: "homeassistant_notify",
  publish: "homeassistant_publish",
};

/** Successful routine reads and sensor updates run every few minutes; only these aren't audited when they succeed. */
const QUIET_WHEN_OK = new Set<HaOp>(["health", "publish", "devices"]);

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

  const def = BUILT_IN_TOOLS.get(tool) ?? SYSTEM_TOOLS.get(tool)!;
  const parsed = parseToolArgs(def, { ...haConnectionArgs(ha.config), ...opArgs });
  if (!parsed.ok) return fail(`Invalid arguments: ${parsed.error}`);
  const args = parsed.args;

  // Same network scope as an agent's call: Home Assistant must be inside an allowed network.
  const rules = await deps.db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, req.orgId));
  const scope = checkScope(def.manifest, args, rules);
  if (!scope.allow) return fail(`Blocked by policy: ${scope.reason}`);

  // The token's own scope still applies: the hosts and tools its owner allowed.
  const [secret] = await deps.db.select().from(secrets).where(and(eq(secrets.orgId, req.orgId), eq(secrets.name, HA_TOKEN_SECRET)));
  if (!secret) return fail("Add Home Assistant's access token first");
  if (secret.allowedTools.length > 0 && !secret.allowedTools.includes(tool)) return fail(`The ${HA_TOKEN_SECRET} secret may not be used with ${tool}`);
  if (secret.allowedHosts.length > 0) {
    const hosts = secret.allowedHosts.map(parseRange).filter((r): r is IpRange => r !== null);
    if (!scope.ranges.every((t) => hosts.some((h) => contains(h, t)))) return fail(`The ${HA_TOKEN_SECRET} secret may not be used against ${ha.config.host}`);
  }
  const token = decryptSecret(deps.masterKey, secret.id, secret);

  let response: { ok: boolean; result?: unknown; error?: string };
  try {
    response = await deps.toolbox.call(tool, { ...args, token });
  } catch (err) {
    response = { ok: false, error: `Toolbox unavailable: ${(err as Error).message}` };
  }
  if (!response.ok) return fail(redactSecrets(response.error ?? "Home Assistant call failed", [token]));
  const result = response.result === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(response.result), [token]));
  if (!QUIET_WHEN_OK.has(req.op)) await audit(true, { args: { ...args, token: `secret:${HA_TOKEN_SECRET}` } });
  return { ok: true, result };
}
