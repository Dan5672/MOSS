// The agent loop. One run = one task: the agent works through tool calls until it finishes,
// hits its step limit, or is stopped by budget, kill switch or pause. Every step is recorded.
//
// Two loops share the same run setup (tools, recording, safety checks):
//   - API providers: MOSS drives the model turn by turn (runApiLoop, below).
//   - Claude subscription: the Claude Code CLI drives the model, and calls MOSS's tools through a
//     local MCP server that runs the same execute() path (see claude-code.ts).
import { agentToolGrants, effectivePermissions, getBudgetStatus, getSetting, ingestDiscoveredHosts, writeAudit, type DiscoveredHost } from "@moss/core";
import {
  agentRuns,
  agents,
  agentSkills,
  models,
  providers,
  rolePermissions,
  runSteps,
  skills,
  tokenUsage,
  type Database,
} from "@moss/db";
import {
  BudgetExceededError,
  costOf,
  KNOWN_PRICING,
  MeteredSession,
  type ModelPricing,
  type ProviderAdapter,
  type UsageEntry,
  type ToolCallRequest,
  type ToolResult,
  type ToolSpec,
  type TurnInput,
} from "@moss/llm";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runClaudeCodeLoop, type ClaudeCodeConfig } from "./claude-code.js";
import type { GateClient } from "./gate-client.js";
import { PLATFORM_TOOL_MAP, platformToolSchema } from "./platform-tools.js";
import { buildSystemPrompt, buildTaskMessage } from "./prompt.js";

// --- Runtime ----------------------------------------------------------------------------------

export type ProviderFactory = (provider: typeof providers.$inferSelect) => ProviderAdapter;

export interface RunInput {
  agentId: string;
  task: string;
  trigger: "schedule" | "event" | "ticket" | "chat" | "manual";
  triggerRef?: string;
}

export interface RunDeps {
  db: Database;
  gate: GateClient;
  providerFor: ProviderFactory;
  /** How to run agents whose model is on a Claude subscription. Without it, those runs fail cleanly. */
  claudeCode?: ClaudeCodeConfig;
  now?: () => Date;
}

export interface RunOutcome {
  runId: string | null;
  status: "succeeded" | "failed" | "aborted" | "skipped";
  summary: string;
  steps: number;
}

type FinalStatus = "succeeded" | "failed" | "aborted";
type StepKind = typeof runSteps.$inferInsert.kind;

/** Everything a loop needs for one run; built once by prepareRun. */
export interface PreparedRun {
  agent: typeof agents.$inferSelect;
  model: typeof models.$inferSelect;
  provider: typeof providers.$inferSelect;
  runId: string;
  system: string;
  task: string;
  toolSpecs: ToolSpec[];
  maxSteps: number;
  step(kind: StepKind, content: unknown): Promise<unknown>;
  finish(status: FinalStatus, summary: string): Promise<RunOutcome>;
  /** Runs one tool call: gate for network tools, in-process for platform tools. Throws LoopDetectedError. */
  execute(call: ToolCallRequest): Promise<ToolResult>;
  /** Re-checked before every model call and tool call: agent still active, kill switch off, under budget. */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  recordUsage(usage: UsageEntry[]): Promise<void>;
  pricing(modelId: string): ModelPricing | undefined;
}

const MAX_RESULT_CHARS = 30_000;
const MAX_IDENTICAL_CALLS = 3;
// Tools whose results carry hosts for the inventory.
const DISCOVERY_TOOLS = new Set(["nmap_scan", "arp_scan", "unifi_clients", "name_lookup"]);

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${stableKey((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function truncate(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${text.length - MAX_RESULT_CHARS} characters]`;
}

async function prepareRun(deps: RunDeps, input: RunInput): Promise<PreparedRun | RunOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const [row] = await db
    .select({ agent: agents, model: models, provider: providers })
    .from(agents)
    .innerJoin(models, eq(agents.modelId, models.id))
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(eq(agents.id, input.agentId));
  if (!row) throw new Error("Agent not found, or it has no model assigned");
  const { agent, model, provider } = row;
  const orgId = agent.orgId;

  if (agent.status !== "active") return { runId: null, status: "skipped", summary: `Agent is ${agent.status}`, steps: 0 };
  if (await getSetting(db, orgId, "agents.kill_switch")) return { runId: null, status: "skipped", summary: "Kill switch is on", steps: 0 };
  if (!model.enabled || !provider.enabled) return { runId: null, status: "skipped", summary: "The agent's model or provider is disabled", steps: 0 };

  // Skills (instructions + tool grants) and role permissions.
  const skillRows = await db
    .select({ name: skills.name, instructions: skills.instructions, toolGrants: skills.toolGrants })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agent.id));
  // Skills give instructions; which tools the agent has also counts per-agent overrides (see agentToolGrants).
  const grants = await agentToolGrants(db, agent.id);
  const permRows = agent.roleId
    ? await db.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, agent.roleId))
    : [];
  const permissions = effectivePermissions(permRows.map((r) => r.p), "agent");

  const platformTools = [...grants].flatMap((name) => {
    const t = PLATFORM_TOOL_MAP.get(name);
    return t && permissions.has(t.permission) ? [t] : [];
  });
  const networkTools = await deps.gate.listTools(agent.id);
  const toolSpecs: ToolSpec[] = [
    ...networkTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...platformTools.map((t) => ({ name: t.name, description: t.description, inputSchema: platformToolSchema(t) })),
  ];
  const networkToolNames = new Set(networkTools.map((t) => t.name));

  // Pricing: prices configured on the org's models first, then the built-in table.
  const modelRows = await db.select().from(models).where(eq(models.orgId, orgId));
  const pricing = (id: string): ModelPricing | undefined => {
    const m = modelRows.find((r) => r.modelId === id);
    const configured = m && Number(m.inputPricePerMTok) + Number(m.outputPricePerMTok) > 0;
    return configured
      ? {
          input: Number(m.inputPricePerMTok),
          output: Number(m.outputPricePerMTok),
          cacheRead: Number(m.cacheReadPricePerMTok),
          cacheWrite: Number(m.cacheWritePricePerMTok),
        }
      : KNOWN_PRICING[id];
  };
  // A subscription has no per-token price: usage is recorded in tokens, and cost stays 0.
  const costPricing = provider.kind === "claude_code" ? () => undefined : pricing;

  const [run] = await db
    .insert(agentRuns)
    .values({ orgId, siteId: agent.siteId, agentId: agent.id, trigger: input.trigger, triggerRef: input.triggerRef ?? null })
    .returning({ id: agentRuns.id });
  const runId = run!.id;
  let seq = 0;
  const step = (kind: StepKind, content: unknown) => db.insert(runSteps).values({ runId, seq: seq++, kind, content: content as Record<string, unknown> });

  const check: PreparedRun["check"] = async () => {
    const [current] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agent.id));
    if (current?.status !== "active") return { ok: false, reason: `agent is ${current?.status ?? "missing"}` };
    if (await getSetting(db, orgId, "agents.kill_switch")) return { ok: false, reason: "kill switch is on" };
    if ((await getBudgetStatus(db, orgId, agent.id, now())).overHard) {
      // A hard limit pauses the agent until a human raises the budget or resumes it.
      await db
        .update(agents)
        .set({ status: "paused", pausedReason: "Hard budget limit reached", updatedAt: now() })
        .where(and(eq(agents.id, agent.id), eq(agents.status, "active")));
      await writeAudit(db, { orgId, actorType: "system", action: "agent.pause", targetType: "agent", targetId: agent.id, details: { reason: "hard budget limit reached", runId } });
      return { ok: false, reason: "hard budget limit reached; the agent has been paused" };
    }
    return { ok: true };
  };

  const recordUsage = async (usage: UsageEntry[]) => {
    if (usage.length === 0) return;
    await db.insert(tokenUsage).values(
      usage.map((u) => {
        const p = costPricing(u.model);
        return {
          orgId,
          agentId: agent.id,
          runId,
          modelId: model.id,
          servedModel: u.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          costUsd: (p ? costOf(u, p) : 0).toFixed(6),
        };
      }),
    );
  };

  const finish = async (status: FinalStatus, summary: string): Promise<RunOutcome> => {
    await db.update(agentRuns).set({ status, summary: summary.slice(0, 4000), endedAt: now() }).where(eq(agentRuns.id, runId));
    return { runId, status, summary, steps: seq };
  };

  const callCounts = new Map<string, number>();

  async function execute(call: ToolCallRequest): Promise<ToolResult> {
    await step("tool_call", { id: call.id, name: call.name, input: call.input });
    const key = `${call.name}:${stableKey(call.input)}`;
    const count = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, count);
    if (count > MAX_IDENTICAL_CALLS) {
      throw new LoopDetectedError(`The same ${call.name} call was made ${count} times`);
    }

    let content: unknown;
    let isError = false;
    if (networkToolNames.has(call.name)) {
      const res = await deps.gate.callTool({ agentId: agent.id, tool: call.name, args: call.input, runId });
      if (!res.allowed) {
        await step("policy_denied", { id: call.id, name: call.name, code: res.code, reason: res.reason });
        return { id: call.id, content: `DENIED by policy (${res.code}): ${res.reason}`, isError: true };
      }
      isError = !res.ok;
      content = res.ok ? res.result : { error: res.error };
      if (res.ok && DISCOVERY_TOOLS.has(call.name)) {
        const hosts = ((res.result as { hosts?: DiscoveredHost[] })?.hosts ?? []).filter((h) => (h as { status?: string }).status !== "down");
        const ingest = await ingestDiscoveredHosts(db, orgId, hosts, `agent:${agent.id}`);
        content = { ...(res.result as object), inventory: { newAssets: ingest.created.length, updatedAssets: ingest.updated.length } };
      }
    } else {
      const tool = PLATFORM_TOOL_MAP.get(call.name);
      if (!tool || !platformTools.includes(tool)) {
        isError = true;
        content = { error: `Tool ${call.name} is not available to you` };
      } else {
        const parsed = tool.args.strict().safeParse(call.input);
        if (!parsed.success) {
          isError = true;
          content = { error: `Invalid arguments: ${z.prettifyError(parsed.error)}` };
        } else {
          try {
            content = await tool.run({ db, orgId, agentId: agent.id, gate: deps.gate, runId }, parsed.data);
          } catch (err) {
            isError = true;
            content = { error: (err as Error).message };
          }
        }
      }
    }
    const text = truncate(typeof content === "string" ? content : JSON.stringify(content));
    await step("tool_result", { id: call.id, name: call.name, isError, content: text.slice(0, 10_000) });
    return { id: call.id, content: text, isError };
  }

  return {
    agent,
    model,
    provider,
    runId,
    system: buildSystemPrompt(agent, skillRows),
    task: buildTaskMessage(input.task, input.trigger, now()),
    toolSpecs,
    maxSteps: agent.maxStepsPerRun,
    step,
    finish,
    execute,
    check,
    recordUsage,
    pricing,
  };
}

export async function runAgent(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
  const run = await prepareRun(deps, input);
  if (!("execute" in run)) return run; // skipped before a run was created
  try {
    if (run.provider.kind === "claude_code") {
      if (!deps.claudeCode) return await run.finish("failed", "This MOSS worker is not set up to run Claude subscription agents.");
      return await runClaudeCodeLoop(run, deps.claudeCode);
    }
    return await runApiLoop(deps, run);
  } catch (err) {
    await run.step("error", { message: (err as Error).message });
    if (err instanceof BudgetExceededError || err instanceof LoopDetectedError) return await run.finish("aborted", (err as Error).message);
    return await run.finish("failed", `Run failed: ${(err as Error).message}`);
  }
}

/** API providers: MOSS sends each turn to the model and executes the tool calls it returns. */
async function runApiLoop(deps: RunDeps, run: PreparedRun): Promise<RunOutcome> {
  const session = new MeteredSession(
    deps.providerFor(run.provider).startSession({ model: run.model.modelId, system: run.system, tools: run.toolSpecs, effort: run.agent.effort }),
    { check: run.check },
    { record: ({ usage }) => run.recordUsage(usage) },
    run.pricing,
  );

  let next: TurnInput = { text: run.task };
  let lastText = "";
  for (let turn = 0; turn < run.maxSteps; turn++) {
    const result = await session.send(next);
    if (result.text) lastText = result.text;
    await run.step("message", { text: result.text, toolCalls: result.toolCalls, stopReason: result.stopReason, servedModel: result.servedModel });

    if (result.stopReason === "refusal") return run.finish("failed", `The model declined the task${result.stopDetail ? ` (${result.stopDetail})` : ""}.`);
    if (result.toolCalls.length === 0) {
      if (result.stopReason === "max_tokens") return run.finish("failed", "The model's response was cut off (max tokens).");
      return run.finish("succeeded", lastText || "Done.");
    }
    const toolResults: ToolResult[] = [];
    for (const call of result.toolCalls) toolResults.push(await run.execute(call));
    next = { toolResults };
  }
  return run.finish("aborted", `Stopped after reaching the limit of ${run.maxSteps} steps. ${lastText}`.trim());
}

export class LoopDetectedError extends Error {
  constructor(detail: string) {
    super(`Loop detected: ${detail}`);
  }
}
