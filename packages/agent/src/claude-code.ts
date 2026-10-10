// Runs an agent on the owner's Claude subscription by driving the Claude Code CLI.
//
// The CLI is locked down so it is only a model loop, not a coding agent:
//   --tools ""             every built-in tool (shell, files, web) is removed
//   --strict-mcp-config    only the MCP server we pass is loaded; no user or project config
//   --allowedTools / dontAsk  only MOSS's tools may run, without prompting
//   --setting-sources ""   no settings, hooks or CLAUDE.md from anywhere
// and it runs in an empty temporary home. Its only tools are MOSS's, served by a per-run MCP server
// on 127.0.0.1 that goes through the same execute() path as API runs: policy gate, loop detection,
// step recording. Model traffic goes to the gate's LLM proxy, which adds the subscription token,
// so the token never enters the worker. As a final check, the run is refused if Claude Code ever
// reports a tool that isn't one of MOSS's.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startMcpToolServer } from "./mcp-server.js";
import type { PreparedRun, RunOutcome } from "./runtime.js";
import { LoopDetectedError } from "./runtime.js";

export interface ClaudeCodeConfig {
  /** Base URL the CLI sends model requests to: the gate's LLM proxy for this provider. */
  baseUrlFor(providerId: string): string;
  /** What the CLI presents to that URL: the worker's gate token (the gate swaps in the real credential). */
  apiKey: string;
  /** The claude executable (default "claude" on PATH). */
  binary?: string;
  timeoutMs?: number;
  /** How often the agent's status, the kill switch and its budget are re-checked while the CLI runs. */
  watchIntervalMs?: number;
}

const MCP_SERVER = "moss";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: string };
type StreamEvent =
  | { type: "system"; subtype?: string; tools?: string[] }
  | { type: "assistant"; message: { id: string; model: string; content: ContentBlock[]; stop_reason?: string | null; usage?: Usage } }
  | { type: "result"; subtype: string; is_error?: boolean; result?: string; api_error_status?: number | null; permission_denials?: unknown[] }
  | { type: string };

/** The exact argument list: kept in one place so tests can assert the lockdown. */
export function claudeCodeArgs(run: Pick<PreparedRun, "task" | "system" | "toolSpecs" | "model" | "agent">, mcpConfigPath: string): string[] {
  const args = [
    "-p",
    run.task,
    "--model",
    run.model.modelId,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    run.system,
  ];
  if (run.agent.effort) args.push("--effort", run.agent.effort);
  if (run.toolSpecs.length) args.push("--allowedTools", ...run.toolSpecs.map((t) => `${MCP_PREFIX}${t.name}`));
  return args;
}

export async function runClaudeCodeLoop(run: PreparedRun, cfg: ClaudeCodeConfig): Promise<RunOutcome> {
  let stopped: { status: "aborted" | "failed"; summary: string } | undefined;
  let kill = () => {};
  const stop = (status: "aborted" | "failed", summary: string) => {
    if (stopped) return;
    stopped = { status, summary };
    kill();
  };

  let toolCalls = 0;
  const server = await startMcpToolServer({
    name: MCP_SERVER,
    tools: run.toolSpecs,
    call: async (name, args) => {
      if (stopped) return { text: `The run is stopping: ${stopped.summary}`, isError: true };
      const verdict = await run.check();
      if (!verdict.ok) {
        stop("aborted", `Stopped: ${verdict.reason}`);
        return { text: `Stopped: ${verdict.reason}`, isError: true };
      }
      if (++toolCalls > run.maxSteps) {
        stop("aborted", `Stopped after reaching the limit of ${run.maxSteps} steps.`);
        return { text: "Step limit reached; stop now.", isError: true };
      }
      try {
        const r = await run.execute({ id: `mcp_${toolCalls}`, name, input: args });
        return { text: r.content, isError: r.isError ?? false };
      } catch (err) {
        if (err instanceof LoopDetectedError) stop("aborted", err.message);
        throw err;
      }
    },
  });

  const home = await mkdtemp(join(tmpdir(), "moss-claude-"));
  const mcpConfigPath = join(home, "mcp.json");
  await writeFile(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }),
    { mode: 0o600 },
  );

  // A clean environment: nothing from the worker's own env reaches the CLI except what it needs.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ANTHROPIC_BASE_URL: cfg.baseUrlFor(run.provider.id),
    ANTHROPIC_API_KEY: cfg.apiKey,
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // The CLI retries failed requests for minutes by default (even a rejected token). A few retries
    // ride out a blip; anything longer is better reported than waited on.
    CLAUDE_CODE_MAX_RETRIES: "3",
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT; // Windows (development)

  const child = spawn(cfg.binary ?? "claude", claudeCodeArgs(run, mcpConfigPath), { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  kill = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5_000).unref();
  };
  if (stopped) kill();

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));

  // Usage is recorded once per model response (several stream events can share a message id).
  const usageById = new Map<string, { model: string; usage: Usage }>();
  const flushed = new Set<string>();
  const flushUsage = async (except?: string) => {
    const entries = [...usageById].filter(([id]) => id !== except && !flushed.has(id));
    for (const [id] of entries) flushed.add(id);
    await run.recordUsage(
      entries.map(([, { model, usage: u }]) => ({
        model,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      })),
    );
  };

  let result: Extract<StreamEvent, { type: "result" }> | undefined;
  let lastText = "";
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

  const watch = setInterval(async () => {
    const verdict = await run.check().catch(() => ({ ok: true as const }));
    if (!verdict.ok) stop("aborted", `Stopped: ${verdict.reason}`);
  }, cfg.watchIntervalMs ?? 3_000);
  const timer = setTimeout(() => stop("aborted", `Stopped after ${Math.round((cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} minutes.`), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let event: StreamEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "system" && "tools" in event && Array.isArray(event.tools)) {
        const foreign = event.tools.filter((t) => !t.startsWith(MCP_PREFIX));
        if (foreign.length) {
          await run.step("error", { message: `Claude Code offered tools outside MOSS: ${foreign.join(", ")}` });
          stop("failed", `Refused to run: Claude Code made tools available that MOSS does not control (${foreign.join(", ")}).`);
        }
      } else if (event.type === "assistant" && "message" in event) {
        const m = event.message;
        // "<synthetic>" messages are the CLI's own notices (e.g. an API error), not model output.
        if (m.usage && m.model !== "<synthetic>") {
          usageById.set(m.id, { model: m.model, usage: m.usage });
          await flushUsage(m.id);
        }
        const text = m.content.flatMap((b) => (b.type === "text" && "text" in b ? [b.text] : [])).join("");
        const calls = m.content.flatMap((b) =>
          b.type === "tool_use" && "name" in b ? [{ id: b.id, name: b.name.replace(MCP_PREFIX, ""), input: b.input }] : [],
        );
        if (text) lastText = text;
        if (text || calls.length) await run.step("message", { text, toolCalls: calls, stopReason: m.stop_reason ?? null, servedModel: m.model });
      } else if (event.type === "result" && "subtype" in event) {
        result = event;
      }
    }
    await exited;
  } finally {
    clearInterval(watch);
    clearTimeout(timer);
    await flushUsage().catch(() => {});
    await server.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  if (stopped) return run.finish(stopped.status, `${stopped.summary} ${lastText}`.trim());
  if (result && result.subtype === "success" && !result.is_error) return run.finish("succeeded", result.result || lastText || "Done.");
  const detail = (result?.result || stderr.trim().split("\n").slice(-3).join(" ") || "no output").slice(0, 500);
  const status = result?.api_error_status;
  if (status === 401 || status === 403 || /invalid api key|unauthori[sz]ed/i.test(detail)) {
    return run.finish("failed", `Claude rejected the subscription token (${detail}). Create a new one with \`claude setup-token\` and update this provider in Models.`);
  }
  if (status === 429) {
    return run.finish("failed", `The Claude subscription's usage limit was reached (${detail}). Retry the run once the limit resets.`);
  }
  return run.finish("failed", `Claude Code ${result ? `stopped (${result.subtype})` : `exited with code ${child.exitCode}`}: ${detail}`);
}
