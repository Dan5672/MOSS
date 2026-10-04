// The agent loop. One run = one task: the agent works through tool calls until it finishes,
// hits its step limit, or is stopped by budget, kill switch or pause. Every step is recorded.
import { effectivePermissions, getBudgetStatus, getSetting, ingestDiscoveredHosts, writeAudit, type DiscoveredHost } from "@moss/core";
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
  type ToolCallRequest,
  type ToolResult,
  type ToolSpec,
  type TurnInput,
} from "@moss/llm";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { PLATFORM_TOOL_MAP, platformToolSchema } from "./platform-tools.js";
import { buildSystemPrompt, buildTaskMessage } from "./prompt.js";

// --- Gate client ------------------------------------------------------------------------------

export interface GateToolSpec {
  name: string;
  class: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type GateToolResponse =
  | { allowed: true; ok: boolean; result?: unknown; error?: string; durationMs?: number }
  | { allowed: false; code: string; reason: string };

export interface GateClient {
  listTools(agentId: string): Promise<GateToolSpec[]>;
  callTool(req: { agentId: string; tool: string; args: unknown; changeId?: string; runId?: string }): Promise<GateToolResponse>;
}

export class HttpGateClient implements GateClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25 * 60_000),
    });
    if (!res.ok) throw new Error(`Gate returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async listTools(agentId: string) {
    return (await this.request<{ tools: GateToolSpec[] }>(`/v1/agents/${agentId}/tools`)).tools;
  }

  callTool(req: Parameters<GateClient["callTool"]>[0]) {
    return this.request<GateToolResponse>("/v1/tool-calls", req);
  }
}

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
  now?: () => Date;
}

export interface RunOutcome {
  runId: string | null;
  status: "succeeded" | "failed" | "aborted" | "skipped";
  summary: string;
  steps: number;
}

const MAX_RESULT_CHARS = 30_000;
const MAX_IDENTICAL_CALLS = 3;
const DISCOVERY_TOOLS = new Set(["nmap_scan", "arp_scan"]);

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

export async function runAgent(deps: RunDeps, input: RunInput): Promise<RunOutcome> {
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
  const grants = new Set(skillRows.flatMap((s) => s.toolGrants));
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

  const [run] = await db
    .insert(agentRuns)
    .values({ orgId, siteId: agent.siteId, agentId: agent.id, trigger: input.trigger, triggerRef: input.triggerRef ?? null })
    .returning({ id: agentRuns.id });
  const runId = run!.id;
  let seq = 0;
  const step = (kind: typeof runSteps.$inferInsert.kind, content: unknown) =>
    db.insert(runSteps).values({ runId, seq: seq++, kind, content: content as Record<string, unknown> });

  const session = new MeteredSession(
    deps.providerFor(provider).startSession({
      model: model.modelId,
      system: buildSystemPrompt(agent, skillRows),
      tools: toolSpecs,
      effort: agent.effort,
    }),
    {
      // Re-checked before every model call, so pausing an agent or pulling the kill switch stops a running loop.
      check: async () => {
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
      },
    },
    {
      record: async ({ usage }) => {
        if (usage.length === 0) return;
        await db.insert(tokenUsage).values(
          usage.map((u) => {
            const p = pricing(u.model);
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
      },
    },
    pricing,
  );

  const finish = async (status: RunOutcome["status"] & ("succeeded" | "failed" | "aborted"), summary: string): Promise<RunOutcome> => {
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
            content = await tool.run({ db, orgId, agentId: agent.id }, parsed.data);
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

  let next: TurnInput = { text: buildTaskMessage(input.task, input.trigger, now()) };
  let lastText = "";
  try {
    for (let turn = 0; turn < agent.maxStepsPerRun; turn++) {
      const result = await session.send(next);
      if (result.text) lastText = result.text;
      await step("message", { text: result.text, toolCalls: result.toolCalls, stopReason: result.stopReason, servedModel: result.servedModel });

      if (result.stopReason === "refusal") return await finish("failed", `The model declined the task${result.stopDetail ? ` (${result.stopDetail})` : ""}.`);
      if (result.toolCalls.length === 0) {
        if (result.stopReason === "max_tokens") return await finish("failed", "The model's response was cut off (max tokens).");
        return await finish("succeeded", lastText || "Done.");
      }
      const toolResults: ToolResult[] = [];
      for (const call of result.toolCalls) toolResults.push(await execute(call));
      next = { toolResults };
    }
    return await finish("aborted", `Stopped after reaching the limit of ${agent.maxStepsPerRun} steps. ${lastText}`.trim());
  } catch (err) {
    await step("error", { message: (err as Error).message });
    if (err instanceof BudgetExceededError || err instanceof LoopDetectedError) return await finish("aborted", (err as Error).message);
    return await finish("failed", `Run failed: ${(err as Error).message}`);
  }
}

export class LoopDetectedError extends Error {
  constructor(detail: string) {
    super(`Loop detected: ${detail}`);
  }
}
