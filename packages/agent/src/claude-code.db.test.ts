// Claude subscription runs: the real Claude Code CLI, a scripted fake Anthropic API standing in for
// the gate's LLM proxy, a fake policy gate, and Postgres. Skipped unless MOSS_TEST_DATABASE_URL is
// set and `claude` is installed.
import { bootstrapOrg, setNetworkStatus, setSetting } from "@moss/core";
import { agentRuns, agents, assets, models, providers, runSteps, tokenUsage, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeArgs } from "./claude-code.js";
import { loadLibrary, syncBuiltInSkills, type Library } from "./library.js";
import { hireFromTemplate, type Actor } from "./lifecycle.js";
import { runAgent, type GateClient, type GateToolResponse } from "./runtime.js";

const LIBRARY_DIR = fileURLToPath(new URL("../../../library", import.meta.url));
const HAVE_CLAUDE = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
const GATE_TOKEN = "g".repeat(48);

const NMAP_SPEC = {
  name: "nmap_scan",
  class: "read",
  description: "Scan hosts",
  inputSchema: { type: "object", properties: { targets: { type: "array", items: { type: "string" } }, profile: { type: "string" } }, required: ["targets", "profile"] },
};

type Turn = { tools?: { name: string; input: unknown }[]; text?: string; delayMs?: number; status?: number };

describe("claude code lockdown", () => {
  it("removes every built-in tool and only allows MOSS's", () => {
    const args = claudeCodeArgs(
      {
        task: "t",
        system: "s",
        toolSpecs: [{ name: "ping", description: "", inputSchema: {} }],
        model: { modelId: "claude-sonnet-5-5" } as never,
        agent: { effort: "medium" } as never,
      },
      "/tmp/mcp.json",
    );
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(after("--setting-sources")).toBe("");
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual(["mcp__moss__ping"]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe.skipIf(!TEST_DATABASE_URL || !HAVE_CLAUDE)("claude subscription runs (postgres + claude CLI)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let lib: Library;
  let actor: Actor;
  let modelId: string;
  let upstream: Server;
  let upstreamUrl: string;
  let script: Turn[] = [];
  const requests: { tools: string[]; apiKey?: string; path: string }[] = [];
  const gateCalls: { tool: string; args: unknown }[] = [];

  const gate: GateClient = {
    listTools: async () => [NMAP_SPEC],
    callTool: async (req): Promise<GateToolResponse> => {
      gateCalls.push({ tool: req.tool, args: req.args });
      return {
        allowed: true,
        ok: true,
        result: { hosts: [{ ip: "192.168.1.10", status: "up", mac: "aa:bb:cc:00:00:10", vendor: "Synology", hostnames: ["nas.lan"], ports: [] }] },
      };
    },
  };
  const deps = () => ({ db, gate, providerFor: () => { throw new Error("not used"); }, claudeCode: { baseUrlFor: () => upstreamUrl, apiKey: GATE_TOKEN, watchIntervalMs: 200 } });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("agent_claude_code"));
    lib = await loadLibrary(LIBRARY_DIR);
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    actor = { orgId: boot.org.id, userId: boot.owner.id };
    await syncBuiltInSkills(db, actor.orgId, lib.skills.values());
    await setNetworkStatus(db, actor.orgId, { cidr: "192.168.1.0/24", status: "allowed" }, actor.userId);
    const [provider] = await db.insert(providers).values({ orgId: actor.orgId, kind: "claude_code", name: "Claude subscription" }).returning();
    [{ id: modelId }] = await db.insert(models).values({ orgId: actor.orgId, providerId: provider!.id, modelId: "claude-sonnet-5-5", displayName: "Sonnet" }).returning();

    // Scripted Anthropic Messages API (streaming), standing in for the gate's LLM proxy.
    upstream = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      const json = body ? JSON.parse(body) : {};
      requests.push({ path: req.url ?? "", apiKey: req.headers["x-api-key"] as string | undefined, tools: (json.tools ?? []).map((t: { name: string }) => t.name) });
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      const turn = script.shift() ?? { text: "Done." };
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
      if (turn.status) {
        res.writeHead(turn.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      const events: [string, unknown][] = [
        ["message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } } }],
      ];
      let i = 0;
      if (turn.text) {
        events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
        events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: turn.text } }]);
        events.push(["content_block_stop", { type: "content_block_stop", index: i++ }]);
      }
      for (const t of turn.tools ?? []) {
        events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: `toolu_${requests.length}_${i}`, name: t.name, input: {} } }]);
        events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } }]);
        events.push(["content_block_stop", { type: "content_block_stop", index: i++ }]);
      }
      events.push(["message_delta", { type: "message_delta", delta: { stop_reason: turn.tools?.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 50 } }]);
      events.push(["message_stop", { type: "message_stop" }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    upstream?.closeAllConnections();
    upstream?.close();
    await close?.();
  });
  beforeEach(async () => {
    requests.length = 0;
    gateCalls.length = 0;
    await setSetting(db, actor.orgId, "agents.kill_switch", false);
  });

  const hire = (name: string) => hireFromTemplate(db, actor, { template: lib.templates.get("network-admin")!, modelId, name });

  it("runs MOSS tools through the gate, never built-ins, and records tokens at no cost", async () => {
    const nina = await hire("Nina");
    script = [
      {
        text: "Scanning the LAN.",
        tools: [
          { name: "mcp__moss__nmap_scan", input: { targets: ["192.168.1.0/24"], profile: "ping" } },
          { name: "Bash", input: { command: "cat /etc/passwd" } },
        ],
      },
      { text: "Found the NAS at 192.168.1.10." },
    ];
    const outcome = await runAgent(deps(), { agentId: nina.id, task: "Discover the LAN", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "succeeded", summary: "Found the NAS at 192.168.1.10." });

    // Every model request offered only MOSS tools, and authenticated with the gate token.
    const modelRequests = requests.filter((r) => r.path.startsWith("/v1/messages"));
    expect(modelRequests.length).toBeGreaterThanOrEqual(2);
    for (const r of modelRequests) {
      expect(r.tools.length).toBeGreaterThan(0);
      expect(r.tools.every((t) => t.startsWith("mcp__moss__"))).toBe(true);
      expect(r.apiKey).toBe(GATE_TOKEN);
    }
    expect(modelRequests[0]!.tools).toContain("mcp__moss__nmap_scan");
    expect(modelRequests[0]!.tools).toContain("mcp__moss__inventory_search");

    // The scan went through the gate and into the inventory; Bash ran nowhere.
    expect(gateCalls).toEqual([{ tool: "nmap_scan", args: { targets: ["192.168.1.0/24"], profile: "ping" } }]);
    const [nas] = await db.select().from(assets).where(eq(assets.primaryMac, "aa:bb:cc:00:00:10"));
    expect(nas?.name).toBe("nas.lan");
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, outcome.runId!)).orderBy(asc(runSteps.seq));
    expect(steps.filter((s) => s.kind === "tool_call").map((s) => (s.content as { name: string }).name)).toEqual(["nmap_scan"]);
    expect(steps.some((s) => s.kind === "message" && (s.content as { text: string }).text === "Scanning the LAN.")).toBe(true);

    const usage = await db.select().from(tokenUsage).where(eq(tokenUsage.runId, outcome.runId!));
    expect(usage.length).toBe(2);
    expect(usage.every((u) => u.inputTokens === 1000 && u.cacheReadTokens === 200 && Number(u.costUsd) === 0)).toBe(true);
  }, 120_000);

  it("stops a running CLI when the kill switch is pulled", async () => {
    const sam = await hire("Sam");
    script = [{ tools: [{ name: "mcp__moss__nmap_scan", input: { targets: ["192.168.1.0/24"], profile: "ping" } }] }, { text: "late", delayMs: 20_000 }];
    const started = Date.now();
    const running = runAgent(deps(), { agentId: sam.id, task: "Scan", trigger: "manual" });
    while (gateCalls.length === 0) await new Promise((r) => setTimeout(r, 100));
    await setSetting(db, actor.orgId, "agents.kill_switch", true);
    const outcome = await running;
    expect(outcome).toMatchObject({ status: "aborted", summary: expect.stringContaining("kill switch is on") });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("enforces the agent's step limit", async () => {
    const ann = await hire("Ann");
    await db.update(agents).set({ maxStepsPerRun: 1 }).where(eq(agents.id, ann.id));
    script = [
      { tools: [{ name: "mcp__moss__nmap_scan", input: { targets: ["192.168.1.0/24"], profile: "ping" } }] },
      { tools: [{ name: "mcp__moss__nmap_scan", input: { targets: ["192.168.1.0/24"], profile: "top100" } }] },
      { text: "should not get here", delayMs: 20_000 },
    ];
    const outcome = await runAgent(deps(), { agentId: ann.id, task: "Scan", trigger: "manual" });
    expect(outcome).toMatchObject({ status: "aborted", summary: expect.stringContaining("limit of 1 steps") });
    expect(gateCalls).toHaveLength(1);
  }, 60_000);

  it("fails clearly when the subscription token is rejected", async () => {
    const zed = await hire("Zed");
    script = Array.from({ length: 6 }, () => ({ status: 401 }));
    const outcome = await runAgent(deps(), { agentId: zed.id, task: "Scan", trigger: "manual" });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toMatch(/claude setup-token/);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, outcome.runId!));
    expect(run!.status).toBe("failed");
  }, 120_000);
});
