// A tool call MOSS makes for itself (an integration's health check, inventory sync, notification): no agent, so
// the caller names the org, the tool and its arguments. The same rules as agents' calls apply: the arguments must
// parse, the target must be in an allowed network, and the credential secret's own host and tool scope must
// allow it. The secret is decrypted only then, and scrubbed from whatever comes back.
import { decryptSecret, redactSecrets } from "@moss/core";
import { networks, secrets, type Database } from "@moss/db";
import { checkScope, contains, parseRange, type IpRange } from "@moss/policy";
import { BUILT_IN_TOOLS, parseToolArgs, SYSTEM_TOOLS } from "@moss/tools";
import { and, eq } from "drizzle-orm";
import type { ToolboxClient } from "./toolbox-client.js";

export interface SystemCallDeps {
  db: Database;
  masterKey: Buffer;
  toolbox: ToolboxClient;
}

export type SystemCallResult = { ok: true; result: unknown; args: Record<string, unknown> } | { ok: false; error: string };

export async function systemToolCall(
  deps: SystemCallDeps,
  req: { orgId: string; tool: string; args: Record<string, unknown>; secret?: { name: string; arg: string; optional?: boolean }; label: string },
): Promise<SystemCallResult> {
  const def = BUILT_IN_TOOLS.get(req.tool) ?? SYSTEM_TOOLS.get(req.tool);
  if (!def) return { ok: false, error: `Tool ${req.tool} is not available` };
  // An optional credential that isn't stored: call without it.
  const [secret] = req.secret ? await deps.db.select().from(secrets).where(and(eq(secrets.orgId, req.orgId), eq(secrets.name, req.secret.name))) : [];
  const useSecret = req.secret && (secret || !req.secret.optional) ? req.secret : undefined;
  const rawArgs = { ...req.args };
  if (req.secret && !useSecret) delete rawArgs[req.secret.arg];
  const parsed = parseToolArgs(def, rawArgs);
  if (!parsed.ok) return { ok: false, error: `Invalid arguments: ${parsed.error}` };
  const args = parsed.args;

  // Same network scope as an agent's call: the product must be inside an allowed network.
  const rules = await deps.db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, req.orgId));
  const scope = checkScope(def.manifest, args, rules);
  if (!scope.allow) return { ok: false, error: `Blocked by policy: ${scope.reason}` };

  if (!useSecret) return call(deps, req.tool, args, req.label);
  // The credential's own scope still applies: the hosts and tools its owner allowed.
  if (!secret) return { ok: false, error: `Add ${req.label}'s credential first` };
  if (secret.allowedTools.length > 0 && !secret.allowedTools.includes(req.tool)) return { ok: false, error: `The ${useSecret.name} secret may not be used with ${req.tool}` };
  if (secret.allowedHosts.length > 0) {
    const hosts = secret.allowedHosts.map(parseRange).filter((r): r is IpRange => r !== null);
    if (!scope.ranges.every((t) => hosts.some((h) => contains(h, t)))) return { ok: false, error: `The ${useSecret.name} secret may not be used against ${scope.targets.join(", ")}` };
  }
  const value = decryptSecret(deps.masterKey, secret.id, secret);

  const res = await call(deps, req.tool, { ...args, [useSecret.arg]: value }, req.label, value);
  return res.ok ? { ...res, args: { ...args, [useSecret.arg]: `secret:${useSecret.name}` } } : res;
}

async function call(deps: SystemCallDeps, tool: string, args: Record<string, unknown>, label: string, secretValue?: string): Promise<SystemCallResult> {
  const hide = (text: string) => (secretValue ? redactSecrets(text, [secretValue]) : text);
  let response: { ok: boolean; result?: unknown; error?: string };
  try {
    response = await deps.toolbox.call(tool, args);
  } catch (err) {
    response = { ok: false, error: `Toolbox unavailable: ${(err as Error).message}` };
  }
  if (!response.ok) return { ok: false, error: hide(response.error ?? `${label} call failed`) };
  const result = response.result === undefined ? undefined : JSON.parse(hide(JSON.stringify(response.result)));
  return { ok: true, result, args };
}
