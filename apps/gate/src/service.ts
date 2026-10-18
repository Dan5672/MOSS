// The Policy Gate: the only path from an agent's tool call to the toolbox, and the
// only component that can decrypt secrets. Every decision is written to the audit log.
import { businessIntegrationForTool, containsPrivateKey, decryptSecret, getSetting, haConnectionArgs, integrationLicensed, isModuleEnabled, loadHomeAssistant, moduleForTool, redactSecrets, userPermissions, writeAudit } from "@moss/core";
import { agentRuns, changeRequests, type Database } from "@moss/db";
import { and, eq, sql } from "drizzle-orm";
import { checkSecrets, contains, evaluate, EXECUTABLE_CHANGE_STATUSES, extractSecretHandles, parseRange, type DenyCode, type IpRange } from "@moss/policy";
import {
  BUILT_IN_TOOLS,
  customToolDefinition,
  parseToolArgs,
  renderCustomRequest,
  SYSTEM_TOOLS,
  toolInputSchema,
  type ConfigBackupFile,
  type CustomToolSpec,
  type ToolDefinition,
} from "@moss/tools";
import { storeBackup } from "./backups.js";
import { loadAgent, loadContext, loadCustomTool, loadCustomTools, loadToolGrants } from "./context.js";
import { runHomeAssistantOp, type HaOp } from "./home-assistant.js";
import { runIntegrationOp } from "./integrations.js";
import { ssoExchange } from "./sso.js";
import { runMonitorCheck } from "./monitor-check.js";
import { credentialCall } from "./pins.js";
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
  /** For the gate's own requests to the internet (SSO signing keys); tests pass a stand-in. */
  fetch?: typeof fetch;
}

const SECRET_HANDLE = /^secret:([A-Za-z0-9_.-]+)$/;
const KILL_SWITCH_POLL_MS = 1000;

/** Marks a change's planned step as run, unless it already is. False when someone else got there first. */
async function claimStep(db: Database, changeId: string, step: number) {
  const rows = await db
    .update(changeRequests)
    .set({ executedCalls: sql`${changeRequests.executedCalls} || ${JSON.stringify([step])}::jsonb` })
    .where(and(eq(changeRequests.id, changeId), sql`not ${changeRequests.executedCalls} @> ${JSON.stringify([step])}::jsonb`))
    .returning({ id: changeRequests.id });
  return rows.length > 0;
}

async function releaseStep(db: Database, changeId: string, step: number) {
  await db
    .update(changeRequests)
    .set({ executedCalls: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(${changeRequests.executedCalls}) e where e <> ${String(step)}::jsonb)` })
    .where(eq(changeRequests.id, changeId));
}

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
    // MOSS's own system tools (signing in, Home Assistant notifications) are never an agent's, nor a custom tool's name.
    if (SYSTEM_TOOLS.has(req.tool)) return deny("unknown_tool", `Unknown tool ${req.tool}`);
    const custom: CustomToolSpec | null = tools.has(req.tool) ? null : await loadCustomTool(deps.db, agent.orgId, req.tool);
    const def = tools.get(req.tool) ?? (custom ? customToolDefinition(custom) : undefined);
    if (!def) return deny("unknown_tool", `Unknown tool ${req.tool}`);
    const module = moduleForTool(req.tool);
    if (module && !(await isModuleEnabled(deps.db, agent.orgId, module))) {
      return deny("module_disabled", `${req.tool} belongs to the ${module.replace("_", " ")} module, which is switched off`);
    }
    const business = businessIntegrationForTool(req.tool);
    if (business && !(await integrationLicensed(deps.db, agent.orgId, business))) {
      return deny("licence_required", `${req.tool} belongs to the ${business.name} integration, which needs a business licence (Settings → About)`);
    }
    let rawArgs = req.args;
    if (module === "home_assistant") {
      // Agents reach the integration's Home Assistant: its saved address, port and scheme, not the tools' defaults (8123, http).
      const { config } = await loadHomeAssistant(deps.db, agent.orgId);
      if (config.host) {
        const { token, ...connection } = haConnectionArgs(config);
        rawArgs = { token, ...(req.args as Record<string, unknown>), ...connection };
      }
    }
    const parsed = parseToolArgs(def, rawArgs);
    if (!parsed.ok) return deny("invalid_args", parsed.error);
    const args = parsed.args;
    // The CVE lookup sends service names and versions to vulners.com: only once the owner has allowed that.
    if (req.tool === "vuln_scan" && args.profile === "cve" && !(await getSetting(deps.db, agent.orgId, "tools.allow_vulners"))) {
      return deny("setting_disabled", "The CVE lookup sends service versions to vulners.com and isn't allowed in Settings. Use profile safe, or ask the owner to allow it.");
    }

    // A custom tool's only credential is the one its definition declares. A handle passed as an argument
    // would be substituted into a request the owner never scoped it for.
    if (custom && extractSecretHandles(args).length > 0) return deny("invalid_args", "Custom tool arguments can't contain secret handles");
    const secretNames = custom ? (custom.secret ? [custom.secret] : []) : [...new Set(extractSecretHandles(args))];
    const ctx = await loadContext(deps.db, agent, { changeId: req.changeId, secretNames, now: now() });
    const decision = evaluate({ tool: req.tool, args, changeId: req.changeId }, def.manifest, ctx.policy);
    if (!decision.allow) return deny(decision.code, decision.reason);
    // A stored password passed where a tool wants an API key or token would be sent to the device as a key and
    // rejected, which reads like a bad credential. Say what's actually wrong instead.
    for (const arg of ["apiKey", "token"]) {
      const handle = typeof args[arg] === "string" ? /^secret:([A-Za-z0-9_.-]+)$/.exec(args[arg] as string)?.[1] : undefined;
      if (handle && ctx.secretRows.get(handle)?.type === "password") {
        const signIn = def.args.shape && "username" in def.args.shape && "password" in def.args.shape;
        return deny(
          "invalid_args",
          `secret:${handle} is a password, not an API key or token, so it can't go in ${arg}.` +
            (signIn ? ` Sign in with it instead: pass username (the account name) and password: "secret:${handle}", and leave ${arg} out.` : ""),
        );
      }
    }
    if (custom?.secret) {
      const ranges = decision.targets.map(parseRange).filter((r): r is IpRange => r !== null);
      const denied = checkSecrets([custom.secret], req.tool, decision.targets, ranges, ctx.policy);
      if (denied && !denied.allow) return deny(denied.code, denied.reason);
      decision.secretHandles.push(custom.secret);
    }

    // Work a person started may use credentials only if that person could manage them (Settings, Safety). Carrying
    // out an approved change is the approver's decision, not the asker's, so that run may.
    if (decision.secretHandles.length && req.runId && (await getSetting(deps.db, agent.orgId, "agents.credentials_need_manager"))) {
      const [run] = await deps.db
        .select({ by: agentRuns.requestedByUserId, ref: agentRuns.triggerRef })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, req.runId), eq(agentRuns.agentId, agent.id)));
      const change = ctx.policy.change;
      const approvedWork = !!change && run?.ref === change.id && change.agentId === agent.id && EXECUTABLE_CHANGE_STATUSES.has(change.status);
      if (run?.by && !approvedWork && !(await userPermissions(deps.db, run.by)).has("secrets.manage")) {
        return deny("setting_disabled", "This work was started by someone who can't manage credentials, so it can't use stored credentials. Ask an owner or admin to start it.");
      }
    }

    // Decrypt only after the policy allowed the call, and only the secrets it references.
    const secretValues = new Map<string, string>();
    for (const name of decision.secretHandles) {
      const row = ctx.secretRows.get(name)!;
      secretValues.set(name, decryptSecret(deps.masterKey, row.id, row));
    }

    // A planned step is claimed right before it runs, so two calls at once can't both run it. One that failed is
    // released to try again; one stopped by the kill switch isn't, since the device may have done it anyway.
    const step = decision.plannedIndex;
    if (step !== undefined && req.changeId && !(await claimStep(deps.db, req.changeId, step))) {
      return deny("call_already_run", `This step of change ${req.changeId} has already run`);
    }

    // A call that carries a credential only goes to the device MOSS saw the first time (Settings, Security).
    const send = (tool: string, args: Record<string, unknown>, signal: AbortSignal) =>
      secretValues.size ? credentialCall(deps.db, deps.toolbox, agent.orgId, { tool, args, targets: decision.targets, signal }, { type: "agent", id: agent.id }) : deps.toolbox.call(tool, args, signal);

    let response: { ok: boolean; result?: unknown; error?: string; durationMs?: number };
    // The kill switch stops a call that is already running, too: the gate stops waiting and returns nothing.
    const stop = new AbortController();
    const watch = setInterval(() => {
      void getSetting(deps.db, agent.orgId, "agents.kill_switch").then((on) => on && stop.abort(new Error("The kill switch was turned on")), () => {});
    }, KILL_SWITCH_POLL_MS);
    try {
      if (custom) {
        // Rendered only now, after the policy allowed the call; the toolbox checks the result again.
        const rendered = renderCustomRequest(custom, args, custom.secret ? secretValues.get(custom.secret) : undefined);
        response = await send("custom_http", rendered as unknown as Record<string, unknown>, stop.signal);
      } else {
        const callArgs = substituteSecrets(args, secretValues) as Record<string, unknown>;
        // A tool that signs in with a username and a password secret gets the username stored with the secret,
        // when the agent left it out. (After the policy check: the username isn't secret and isn't a target.)
        const shape = def.args.shape as Record<string, unknown>;
        const passwordHandle = typeof args.password === "string" ? SECRET_HANDLE.exec(args.password)?.[1] : undefined;
        const storedUsername = passwordHandle ? ctx.secretRows.get(passwordHandle)?.username : null;
        if ("username" in shape && args.username === undefined && storedUsername) callArgs.username = storedUsername;
        // Scans look names up with the DNS server set for the target's network; an agent can't choose its own.
        if (req.tool === "nmap_scan") {
          const servers = dnsServersFor(args.targets as string[], ctx.policy.networks as { cidr: string; dnsServer?: string | null }[]);
          if (servers.length) callArgs.dnsServers = servers;
          else delete callArgs.dnsServers;
        }
        response = await send(req.tool, callArgs, stop.signal);
      }
    } catch (err) {
      response = { ok: false, error: stop.signal.aborted ? "Stopped: the kill switch was turned on" : `Toolbox unavailable: ${(err as Error).message}` };
    } finally {
      clearInterval(watch);
    }

    // A config backup's content is encrypted and stored here; the agent only gets its id, size and hash.
    if (req.tool === "config_backup" && response.ok && response.result) {
      try {
        response.result = await storeBackup(deps.db, deps.masterKey, { orgId: agent.orgId, siteId: agent.siteId, agentId: agent.id, runId: req.runId }, response.result as ConfigBackupFile);
      } catch (err) {
        response = { ok: false, error: `Could not store the backup: ${(err as Error).message}`, durationMs: response.durationMs };
      }
    }

    if (step !== undefined && req.changeId && !response.ok && !stop.signal.aborted) await releaseStep(deps.db, req.changeId, step);

    // Scrub any secret value the tool echoed back before it is logged or shown to the agent, including a password
    // sent as HTTP Basic auth (base64 of user:password).
    const values = [...secretValues.values()];
    for (const name of decision.secretHandles) {
      const row = ctx.secretRows.get(name)!;
      if (row.username && secretValues.has(name)) values.push(`${row.username}:${secretValues.get(name)}`);
    }
    let result = response.result === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(response.result), values));
    let error = response.error === undefined ? undefined : redactSecrets(response.error, values);
    // A private key never reaches an agent, even one that isn't a stored secret.
    if (containsPrivateKey(JSON.stringify(result ?? "")) || containsPrivateKey(error ?? "")) {
      result = undefined;
      error = "The result contained a private key, so MOSS withheld it.";
      response = { ...response, ok: false };
    }

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
  const checkMonitor = (monitorId: string) => runMonitorCheck({ db: deps.db, toolbox: deps.toolbox, tools, masterKey: deps.masterKey, now: deps.now }, monitorId);

  /** A call MOSS makes for the Home Assistant module; the gate reads the module's config itself. */
  const homeAssistant = (req: { orgId: string; op: HaOp; args?: Record<string, unknown>; userId?: string }) =>
    runHomeAssistantOp({ db: deps.db, masterKey: deps.masterKey, toolbox: deps.toolbox }, req);

  /** A call MOSS makes for an integration (health checks, inventory, Test connection). */
  const integration = (req: { orgId: string; key: string; op: string; args?: Record<string, unknown>; userId?: string }) =>
    runIntegrationOp({ db: deps.db, masterKey: deps.masterKey, toolbox: deps.toolbox }, req);

  /** MOSS's release tags, for a person checking for updates in Settings → About. */
  const releases = async (): Promise<{ ok: true; tags: string[] } | { ok: false; error: string }> => {
    const res = await deps.toolbox.call("moss_releases", { timeoutMs: 15_000 });
    return res.ok ? { ok: true, tags: (res.result as { tags: string[] }).tags } : { ok: false, error: res.error ?? "The toolbox couldn't reach GitHub" };
  };

  /** A person signing in with Microsoft or Google: the code exchanged and the token checked. */
  const sso = (req: Parameters<typeof ssoExchange>[1]) => ssoExchange({ db: deps.db, masterKey: deps.masterKey, toolbox: deps.toolbox, fetch: deps.fetch }, req, deps.now?.());

  return { handleToolCall, listAgentTools, checkMonitor, homeAssistant, integration, releases, sso };
}

export type Gate = ReturnType<typeof createGate>;

/** The DNS servers of the most specific networks holding these targets (at most two). */
export function dnsServersFor(targets: string[], nets: { cidr: string; dnsServer?: string | null }[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    const target = parseRange(t);
    if (!target) continue;
    let best: { dns: string; size: bigint } | null = null;
    for (const n of nets) {
      const r = parseRange(n.cidr);
      if (!n.dnsServer || !r || !contains(r, target)) continue;
      if (!best || r.end - r.start < best.size) best = { dns: n.dnsServer, size: r.end - r.start };
    }
    if (best) out.add(best.dns);
  }
  return [...out].slice(0, 2);
}
