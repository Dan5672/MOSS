// The Policy Gate's decision function. Pure and deterministic: the gate service
// gathers context from the database and calls evaluate() before every tool call.
// Nothing here trusts the LLM — all enforcement is based on recorded state.
import { contains, overlaps, parseRange, type IpRange } from "./ip.js";

export type ToolClass = "read" | "write" | "dangerous";

export interface ToolManifest {
  name: string;
  class: ToolClass;
  /** Argument names whose values are network targets (an IP/CIDR string or an array of them). */
  targetArgs: string[];
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Change request the agent claims to be executing under (required for write tools). */
  changeId?: string;
}

export interface NetworkRule {
  cidr: string;
  status: "allowed" | "off_limits" | "unknown";
}

export interface SecretPolicy {
  name: string;
  /** IPs/CIDRs this secret may be used against. Empty = any target the agent may reach. */
  allowedHosts: string[];
  /** Tools this secret may be passed to. Empty = any tool. */
  allowedTools: string[];
}

export interface ChangeContext {
  id: string;
  status: string;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  plannedCalls: { tool: string; args: Record<string, unknown> }[];
}

export interface PolicyContext {
  now: Date;
  killSwitch: boolean;
  allowDangerousTools: boolean;
  agent: {
    id: string;
    status: "active" | "paused" | "fired";
    overBudget: boolean;
    toolGrants: ReadonlySet<string>;
    secretGrants: ReadonlySet<string>;
  };
  networks: NetworkRule[];
  secrets: ReadonlyMap<string, SecretPolicy>;
  /** The change referenced by call.changeId, if it exists. */
  change?: ChangeContext;
}

export type DenyCode =
  | "kill_switch"
  | "agent_inactive"
  | "over_budget"
  | "tool_not_granted"
  | "invalid_target"
  | "target_not_allowed"
  | "target_off_limits"
  | "dangerous_tool"
  | "change_required"
  | "change_not_executable"
  | "change_outside_window"
  | "call_not_in_change_plan"
  | "secret_not_granted"
  | "secret_scope";

export type PolicyDecision =
  | { allow: true; targets: string[]; secretHandles: string[] }
  | { allow: false; code: DenyCode; reason: string };

/** Change statuses under which planned write calls may execute. */
export const EXECUTABLE_CHANGE_STATUSES = new Set(["approved", "scheduled", "in_progress"]);

const SECRET_HANDLE = /^secret:([A-Za-z0-9_.-]+)$/;

function deny(code: DenyCode, reason: string): PolicyDecision {
  return { allow: false, code, reason };
}

/** Collects target strings from the manifest-declared target arguments. */
export function extractTargets(manifest: ToolManifest, args: Record<string, unknown>): unknown[] {
  return manifest.targetArgs.flatMap((name) => {
    const v = args[name];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  });
}

/** Finds every secret handle anywhere in the arguments. */
export function extractSecretHandles(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const m = SECRET_HANDLE.exec(value);
    if (m?.[1]) out.push(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) extractSecretHandles(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) extractSecretHandles(v, out);
  }
  return out;
}

/** Stable JSON with sorted keys, so planned and actual arguments compare structurally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkTarget(range: IpRange, raw: string, networks: { rule: NetworkRule; range: IpRange }[]): PolicyDecision | null {
  const offLimits = networks.find((n) => n.rule.status === "off_limits" && overlaps(n.range, range));
  if (offLimits) return deny("target_off_limits", `Target ${raw} overlaps off-limits network ${offLimits.rule.cidr}`);
  const allowed = networks.some((n) => n.rule.status === "allowed" && contains(n.range, range));
  if (!allowed) return deny("target_not_allowed", `Target ${raw} is not inside an allowed network`);
  return null;
}

export function evaluate(call: ToolCall, manifest: ToolManifest, ctx: PolicyContext): PolicyDecision {
  if (manifest.name !== call.tool) return deny("tool_not_granted", "Manifest does not match the requested tool");

  // 1. Global and agent state
  if (ctx.killSwitch) return deny("kill_switch", "All agents are paused by the kill switch");
  if (ctx.agent.status !== "active") return deny("agent_inactive", `Agent is ${ctx.agent.status}`);
  if (ctx.agent.overBudget) return deny("over_budget", "Agent has exceeded its hard budget");

  // 2. Tool grant
  if (!ctx.agent.toolGrants.has(call.tool)) return deny("tool_not_granted", `Agent is not granted tool ${call.tool}`);

  // 3. Target scope — unknown subnets are denied by default; off-limits always wins.
  const networks = ctx.networks.flatMap((rule) => {
    const range = parseRange(rule.cidr);
    return range ? [{ rule, range }] : [];
  });
  const targets: string[] = [];
  const targetRanges: IpRange[] = [];
  for (const t of extractTargets(manifest, call.args)) {
    if (typeof t !== "string") return deny("invalid_target", "Targets must be IP or CIDR strings");
    const range = parseRange(t);
    if (!range) return deny("invalid_target", `Target ${JSON.stringify(t)} is not a resolved IP or CIDR`);
    const denied = checkTarget(range, t, networks);
    if (denied) return denied;
    targets.push(t);
    targetRanges.push(range);
  }

  // 4. Tool class
  if (manifest.class === "dangerous" && !ctx.allowDangerousTools) {
    return deny("dangerous_tool", `${call.tool} is a dangerous tool and dangerous tools are disabled`);
  }
  if (manifest.class !== "read") {
    if (!call.changeId) return deny("change_required", `${call.tool} changes state and requires an approved change request`);
    const change = ctx.change;
    if (!change || change.id !== call.changeId) return deny("change_required", `Change ${call.changeId} was not found`);
    if (!EXECUTABLE_CHANGE_STATUSES.has(change.status)) {
      return deny("change_not_executable", `Change ${change.id} is ${change.status}, not approved`);
    }
    if ((change.windowStart && ctx.now < change.windowStart) || (change.windowEnd && ctx.now > change.windowEnd)) {
      return deny("change_outside_window", `Change ${change.id} is outside its scheduled window`);
    }
    const actual = canonicalJson({ tool: call.tool, args: call.args });
    const planned = change.plannedCalls.some((p) => canonicalJson({ tool: p.tool, args: p.args }) === actual);
    if (!planned) return deny("call_not_in_change_plan", `This exact call is not in the plan of change ${change.id}`);
  }

  // 5. Secret handles
  const secretHandles = [...new Set(extractSecretHandles(call.args))];
  for (const name of secretHandles) {
    const secret = ctx.secrets.get(name);
    if (!secret || !ctx.agent.secretGrants.has(name)) return deny("secret_not_granted", `Agent has no grant for secret ${name}`);
    if (secret.allowedTools.length > 0 && !secret.allowedTools.includes(call.tool)) {
      return deny("secret_scope", `Secret ${name} may not be used with ${call.tool}`);
    }
    if (secret.allowedHosts.length > 0) {
      const hostRanges = secret.allowedHosts.map(parseRange).filter((r): r is IpRange => r !== null);
      if (targetRanges.length === 0) return deny("secret_scope", `Secret ${name} is host-scoped but the call has no target`);
      const outside = targetRanges.findIndex((t) => !hostRanges.some((h) => contains(h, t)));
      if (outside !== -1) return deny("secret_scope", `Secret ${name} may not be used against ${targets[outside]}`);
    }
  }

  return { allow: true, targets, secretHandles };
}
