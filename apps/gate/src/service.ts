// The Policy Gate: the only path from an agent's tool call to the toolbox, and the
// only component that can decrypt secrets. Every decision is written to the audit log.
import { decryptSecret, isModuleEnabled, moduleForTool, redactSecrets, writeAudit } from "@moss/core";
import type { Database } from "@moss/db";
import { checkSecrets, evaluate, extractSecretHandles, parseRange, type DenyCode, type IpRange } from "@moss/policy";
import {
  BUILT_IN_TOOLS,
  customToolDefinition,
  parseToolArgs,
  renderCustomRequest,
  toolInputSchema,
  type ConfigBackupFile,
  type CustomToolSpec,
  type ToolDefinition,
} from "@moss/tools";
import { storeBackup } from "./backups.js";
import { loadAgent, loadContext, loadCustomTool, loadCustomTools, loadToolGrants } from "./context.js";
import { runHomeAssistantOp, type HaOp } from "./home-assistant.js";
import { runMonitorCheck } from "./monitor-check.js";
import type { ToolboxClient } from "./toolbox-client.js";

export interface ToolCallRequest {
  agentId: string;
  tool: string;
  args: unknown;
  changeId?: string;
  runId?: string;
}

export type ToolCallResponse =
  | { allowed: true; ok: boolean; result?: unknown; error?: string; durationMs?: number }
  | { allowed: false; code: DenyCode | "unknown_agent" | "unknown_tool" | "invalid_args"; reason: string };

export interface GateDeps {
  db: Database;
  masterKey: Buffer;
  toolbox: ToolboxClient;
  tools?: ReadonlyMap<string, ToolDefinition>;
  now?: () => Date;
}

const SECRET_HANDLE = /^secret:([A-Za-z0-9_.-]+)$/;

/** Replaces secret handles with their values in a deep copy of the arguments. */
function substituteSecrets(value: unknown, values: Map<string, string>): unknown {
  if (typeof value === "string") {
    const m = SECRET_HANDLE.exec(value);
    return m?.[1] && values.has(m[1]) ? values.get(m[1]) : value;
  }
  if (Array.isArray(value)) return value.map((v) => substituteSecrets(v, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteSecrets(v, values)]));
  }
  return value;
}

export function createGate(deps: GateDeps) {
  const tools = deps.tools ?? BUILT_IN_TOOLS;
  const now = deps.now ?? (() => new Date());

  async function handleToolCall(req: ToolCallRequest): Promise<ToolCallResponse> {
    const agent = await loadAgent(deps.db, req.agentId);
    if (!agent) return { allowed: false, code: "unknown_agent", reason: "Unknown agent" };

    const audit = (action: string, details: Record<string, unknown>) =>
      writeAudit(deps.db, {
        orgId: agent.orgId,
        siteId: agent.siteId,
        actorType: "agent",
        actorId: agent.id,
        action,
        targetType: "tool",
        targetId: req.tool,
        details: { ...details, runId: req.runId ?? null, changeId: req.changeId ?? null },
      });
    const deny = async (code: Exclude<ToolCallResponse, { allowed: true }>["code"], reason: string) => {
      await audit("tool.denied", { code, reason, args: req.args });
      return { allowed: false as const, code, reason };
    };

    // Built-in tools first; a name that isn't built in may be one of the org's custom tools.
    const custom: CustomToolSpec | null = tools.has(req.tool) ? null : await loadCustomTool(deps.db, agent.orgId, req.tool);
    const def = tools.get(req.tool) ?? (custom ? customToolDefinition(custom) : undefined);
    if (!def) return deny("unknown_tool", `Unknown tool ${req.tool}`);
    const module = moduleForTool(req.tool);
    if (module && !(await isModuleEnabled(deps.db, agent.orgId, module))) {
      return deny("module_disabled", `${req.tool} belongs to the ${module.replace("_", " ")} module, which is switched off`);
    }
    const parsed = parseToolArgs(def, req.args);
    if (!parsed.ok) return deny("invalid_args", parsed.error);
    const args = parsed.args;

    // A custom tool's only credential is the one its definition declares. A handle passed as an argument
    // would be substituted into a request the owner never scoped it for.
    if (custom && extractSecretHandles(args).length > 0) return deny("invalid_args", "Custom tool arguments can't contain secret handles");
    const secretNames = custom ? (custom.secret ? [custom.secret] : []) : [...new Set(extractSecretHandles(args))];
    const ctx = await loadContext(deps.db, agent, { changeId: req.changeId, secretNames, now: now() });
    const decision = evaluate({ tool: req.tool, args, changeId: req.changeId }, def.manifest, ctx.policy);
    if (!decision.allow) return deny(decision.code, decision.reason);
    if (custom?.secret) {
      const ranges = decision.targets.map(parseRange).filter((r): r is IpRange => r !== null);
      const denied = checkSecrets([custom.secret], req.tool, decision.targets, ranges, ctx.policy);
      if (denied && !denied.allow) return deny(denied.code, denied.reason);
      decision.secretHandles.push(custom.secret);
    }

    // Decrypt only after the policy allowed the call, and only the secrets it references.
    const secretValues = new Map<string, string>();
    for (const name of decision.secretHandles) {
      const row = ctx.secretRows.get(name)!;
      secretValues.set(name, decryptSecret(deps.masterKey, row.id, row));
    }

    let response: { ok: boolean; result?: unknown; error?: string; durationMs?: number };
    try {
      if (custom) {
        // Rendered only now, after the policy allowed the call; the toolbox checks the result again.
        const rendered = renderCustomRequest(custom, args, custom.secret ? secretValues.get(custom.secret) : undefined);
        response = await deps.toolbox.call("custom_http", rendered as unknown as Record<string, unknown>);
      } else {
        response = await deps.toolbox.call(req.tool, substituteSecrets(args, secretValues) as Record<string, unknown>);
      }
    } catch (err) {
      response = { ok: false, error: `Toolbox unavailable: ${(err as Error).message}` };
    }

    // A config backup's content is encrypted and stored here; the agent only gets its id, size and hash.
    if (req.tool === "config_backup" && response.ok && response.result) {
      try {
        response.result = await storeBackup(deps.db, deps.masterKey, { orgId: agent.orgId, siteId: agent.siteId, agentId: agent.id, runId: req.runId }, response.result as ConfigBackupFile);
      } catch (err) {
        response = { ok: false, error: `Could not store the backup: ${(err as Error).message}`, durationMs: response.durationMs };
      }
    }

    // Scrub any secret value the tool echoed back before it is logged or shown to the agent.
    const values = [...secretValues.values()];
    const result = response.result === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(response.result), values));
    const error = response.error === undefined ? undefined : redactSecrets(response.error, values);

    await audit("tool.call", {
      args, // contains secret handles only, never values
      targets: decision.targets,
      secretsUsed: decision.secretHandles,
      ok: response.ok,
      error: error ?? null,
      durationMs: response.durationMs ?? null,
    });
    return { allowed: true, ok: response.ok, result, error, durationMs: response.durationMs };
  }

  /** Tool specs (for the LLM) for every tool the agent is currently granted. */
  async function listAgentTools(agentId: string) {
    const agent = await loadAgent(deps.db, agentId);
    if (!agent) return [];
    const [grants, custom, haOn] = await Promise.all([
      loadToolGrants(deps.db, agentId),
      loadCustomTools(deps.db, agent.orgId),
      isModuleEnabled(deps.db, agent.orgId, "home_assistant"),
    ]);
    return [...tools.values(), ...custom.filter((c) => !tools.has(c.key)).map(customToolDefinition)]
      .filter((d) => grants.has(d.manifest.name))
      .filter((d) => moduleForTool(d.manifest.name) !== "home_assistant" || haOn)
      .map((d) => ({ name: d.manifest.name, class: d.manifest.class, description: d.description, inputSchema: toolInputSchema(d) }));
  }

  /** Runs one monitor's check; the gate reads the monitor itself, the caller only names it. */
  const checkMonitor = (monitorId: string) => runMonitorCheck({ db: deps.db, toolbox: deps.toolbox, tools }, monitorId);

  /** A call MOSS makes for the Home Assistant module; the gate reads the module's config itself. */
  const homeAssistant = (req: { orgId: string; op: HaOp; args?: Record<string, unknown>; userId?: string }) =>
    runHomeAssistantOp({ db: deps.db, masterKey: deps.masterKey, toolbox: deps.toolbox }, req);

  return { handleToolCall, listAgentTools, checkMonitor, homeAssistant };
}

export type Gate = ReturnType<typeof createGate>;
