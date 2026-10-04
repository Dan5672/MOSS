import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { BudgetExceededError, MeteredSession, type UsageSink } from "./metered.js";
import { MockAdapter } from "./mock.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { KNOWN_PRICING, priceUsage } from "./pricing.js";
import type { ToolSpec } from "./types.js";

const scanTool: ToolSpec = {
  name: "nmap_scan",
  description: "Scan hosts",
  inputSchema: { type: "object", properties: { targets: { type: "array", items: { type: "string" } } }, required: ["targets"] },
};

/** Records request bodies and replays canned JSON responses. */
function fakeFetch(responses: unknown[]) {
  const bodies: any[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, bodies };
}

const claudeMessage = (content: unknown[], stop_reason: string, usage: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
});

describe("AnthropicAdapter", () => {
  it("runs a tool turn, replays thinking blocks unchanged, and opts into fallbacks", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const { fn, bodies } = fakeFetch([
      claudeMessage([thinking, { type: "tool_use", id: "tu_1", name: "nmap_scan", input: { targets: ["192.168.1.0/24"] } }], "tool_use"),
      claudeMessage([{ type: "text", text: "Found 3 hosts." }], "end_turn", { cache_read_input_tokens: 900 }),
    ]);
    const session = new AnthropicAdapter({ apiKey: "test", fetch: fn }).startSession({
      model: "claude-opus-5-5",
      system: "You are a network admin.",
      tools: [scanTool],
      effort: "high",
    });

    const first = await session.send({ text: "Scan the LAN" });
    expect(first.stopReason).toBe("tool_use");
    expect(first.toolCalls).toEqual([{ id: "tu_1", name: "nmap_scan", input: { targets: ["192.168.1.0/24"] } }]);

    const second = await session.send({ toolResults: [{ id: "tu_1", content: "3 hosts up" }] });
    expect(second).toMatchObject({ text: "Found 3 hosts.", stopReason: "end" });
    expect(second.usage[0]).toMatchObject({ cacheReadTokens: 900 });

    const req = bodies[1];
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "high" },
    });
    expect(req.tool_choice).toBeUndefined(); // forced tool choice is rejected on this model
    expect(req.messages[1]).toEqual({ role: "assistant", content: expect.arrayContaining([thinking]) });
    expect(req.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
  });

  it("does not send fallbacks for models that do not support them", async () => {
    const { fn, bodies } = fakeFetch([{ ...claudeMessage([{ type: "text", text: "hi" }], "end_turn"), model: "claude-haiku-4-5" }]);
    await new AnthropicAdapter({ apiKey: "t", fetch: fn }).startSession({ model: "claude-haiku-4-5", system: "s", tools: [] }).send({ text: "hi" });
    expect(bodies[0].fallbacks).toBeUndefined();
    expect(bodies[0].tools).toBeUndefined();
  });

  it("reports per-model usage when a fallback model served the turn", async () => {
    const { fn } = fakeFetch([
      {
        ...claudeMessage([{ type: "text", text: "ok" }], "end_turn"),
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          ],
        },
      },
    ]);
    const turn = await new AnthropicAdapter({ apiKey: "t", fetch: fn }).startSession({ model: "claude-opus-5-5", system: "s", tools: [] }).send({ text: "x" });
    expect(turn.servedModel).toBe("claude-opus-4-8");
    expect(turn.usage.map((u) => u.model)).toEqual(["claude-opus-5-5", "claude-opus-4-8"]);
    const { costUsd } = priceUsage(turn.usage, () => undefined);
    expect(costUsd).toBeCloseTo((500 * 4 + 10 * 20 + 500 * 5 + 100 * 25) / 1e6);
  });

  it("continues pause_turn responses and accumulates usage", async () => {
    const { fn, bodies } = fakeFetch([
      claudeMessage([{ type: "text", text: "working" }], "pause_turn"),
      claudeMessage([{ type: "text", text: "done" }], "end_turn"),
    ]);
    const turn = await new AnthropicAdapter({ apiKey: "t", fetch: fn }).startSession({ model: "claude-opus-5-5", system: "s", tools: [] }).send({ text: "x" });
    expect(turn.text).toBe("done");
    expect(turn.usage).toHaveLength(2);
    expect(bodies).toHaveLength(2);
  });
});

describe("OpenAICompatibleAdapter", () => {
  it("maps tool calls, tool results and cached-token usage", async () => {
    const { fn, bodies } = fakeFetch([
      {
        model: "qwen3:14b",
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "nmap_scan", arguments: '{"targets":["10.0.0.1"]}' } }] } }],
        usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } },
      },
      { choices: [{ finish_reason: "stop", message: { content: "1 host" } }], usage: { prompt_tokens: 350, completion_tokens: 5 } },
    ]);
    const session = new OpenAICompatibleAdapter({ kind: "ollama", fetch: fn }).startSession({ model: "qwen3:14b", system: "sys", tools: [scanTool] });

    const first = await session.send({ text: "scan" });
    expect(first.toolCalls).toEqual([{ id: "c1", name: "nmap_scan", input: { targets: ["10.0.0.1"] } }]);
    expect(first.usage[0]).toMatchObject({ inputTokens: 200, cacheReadTokens: 100, outputTokens: 20 });

    const second = await session.send({ toolResults: [{ id: "c1", content: "timeout", isError: true }] });
    expect(second).toMatchObject({ text: "1 host", stopReason: "end" });
    expect(bodies[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "ERROR: timeout" });
    expect(bodies[0].tools[0].function.name).toBe("nmap_scan");
  });

  it("surfaces malformed tool arguments instead of throwing", async () => {
    const { fn } = fakeFetch([
      { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{bad" } }] } }] },
    ]);
    const turn = await new OpenAICompatibleAdapter({ kind: "openai", apiKey: "k", fetch: fn }).startSession({ model: "m", system: "s", tools: [] }).send({ text: "go" });
    expect(turn.toolCalls[0]!.input).toEqual({ __invalid_json: "{bad" });
  });
});

describe("MeteredSession", () => {
  it("records priced usage and blocks calls once the guard denies", async () => {
    const recorded: Parameters<UsageSink["record"]>[0][] = [];
    let allow = true;
    const session = new MeteredSession(
      new MockAdapter([{ text: "a", usage: { inputTokens: 1_000_000, outputTokens: 0 } }, { text: "b" }]).startSession({
        model: "claude-sonnet-5-5",
        system: "s",
        tools: [],
      }),
      { check: async () => (allow ? { ok: true } : { ok: false, reason: "daily token budget" }) },
      { record: async (e) => void recorded.push(e) },
      () => undefined,
    );

    await session.send({ text: "1" });
    expect(recorded[0]).toMatchObject({ costUsd: KNOWN_PRICING["claude-sonnet-5-5"]!.input, tokens: 1_000_000 });

    allow = false;
    await expect(session.send({ text: "2" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(recorded).toHaveLength(1);
  });

  it("prices user-configured models first and flags unpriced ones", () => {
    const usage = [
      { model: "llama3", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "my-gpt", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ];
    const res = priceUsage(usage, (m) => (m === "my-gpt" ? { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined));
    expect(res).toEqual({ costUsd: 3, unpricedModels: ["llama3"] });
  });
});
