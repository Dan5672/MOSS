// LLM proxy: real SDK clients -> gate (HTTP) -> fake upstream. Run with MOSS_TEST_DATABASE_URL set.
import { bootstrapOrg, encryptSecret, generateMasterKey } from "@moss/core";
import { providers, secrets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { AnthropicAdapter, OpenAICompatibleAdapter } from "@moss/llm";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlmProxy } from "./llm-proxy.js";
import { buildGateServer } from "./server.js";
import { createGate } from "./service.js";

const GATE_TOKEN = "w".repeat(48);
const ANTHROPIC_KEY = "sk-ant-real-key-0123456789";
const OPENROUTER_KEY = "sk-or-real-key-0123456789";

describe.skipIf(!TEST_DATABASE_URL)("gate LLM proxy (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildGateServer>;
  let gateUrl: string;
  let anthropicId: string;
  let openrouterId: string;
  const upstream: { url: string; headers: Record<string, string>; body: any }[] = [];

  const fakeUpstream = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    upstream.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = String(url).includes("anthropic")
      ? {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      : { model: "x", choices: [{ finish_reason: "stop", message: { content: "pong" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  }) as typeof fetch;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_llm"));
    const masterKey = generateMasterKey();
    const { org } = await bootstrapOrg(db, { orgName: "x", ownerEmail: "o@x.test", ownerName: "o", ownerPassword: "a-long-test-password" });
    const addKey = async (name: string, value: string) => {
      const id = randomUUID();
      await db.insert(secrets).values({ id, orgId: org.id, name, type: "api_token", ...encryptSecret(masterKey, id, value) });
      return id;
    };
    [{ id: anthropicId }] = await db
      .insert(providers)
      .values({ orgId: org.id, kind: "anthropic", name: "Claude", apiKeySecretId: await addKey("anthropic-key", ANTHROPIC_KEY) })
      .returning();
    [{ id: openrouterId }] = await db
      .insert(providers)
      .values({ orgId: org.id, kind: "openrouter", name: "OpenRouter", apiKeySecretId: await addKey("openrouter-key", OPENROUTER_KEY) })
      .returning();

    const gate = createGate({ db, masterKey, toolbox: { call: async () => ({ ok: true }) } });
    app = buildGateServer(gate, { token: GATE_TOKEN, llmProxy: createLlmProxy({ db, masterKey, fetch: fakeUpstream }) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    gateUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("forwards Anthropic SDK calls with the real key and never leaks the gate token", async () => {
    const session = new AnthropicAdapter({ apiKey: GATE_TOKEN, baseURL: `${gateUrl}/v1/llm/${anthropicId}` }).startSession({
      model: "claude-opus-5-5",
      system: "s",
      tools: [],
    });
    const turn = await session.send({ text: "ping" });
    expect(turn.text).toBe("pong");

    const call = upstream.at(-1)!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(JSON.stringify(call.headers)).not.toContain(GATE_TOKEN);
    expect(call.headers["anthropic-version"]).toBeDefined();
    expect(call.body.model).toBe("claude-opus-5-5");
  });

  it("forwards OpenAI-compatible calls with a bearer key", async () => {
    const session = new OpenAICompatibleAdapter({ kind: "openrouter", apiKey: GATE_TOKEN, baseURL: `${gateUrl}/v1/llm/${openrouterId}` }).startSession({
      model: "x",
      system: "s",
      tools: [],
    });
    expect((await session.send({ text: "ping" })).text).toBe("pong");
    const call = upstream.at(-1)!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
  });

  it("refuses non-inference paths, bad tokens and unknown providers", async () => {
    const before = upstream.length;
    const get = (path: string, headers: Record<string, string> = { "x-api-key": GATE_TOKEN }) => fetch(`${gateUrl}${path}`, { headers });
    expect((await get(`/v1/llm/${anthropicId}/v1/organizations/users`)).status).toBe(403);
    expect((await get(`/v1/llm/${anthropicId}/v1/../../admin`)).status).not.toBe(200);
    expect((await get(`/v1/llm/${anthropicId}/v1/models`, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await get(`/v1/llm/${randomUUID()}/v1/models`)).status).toBe(404);
    expect(upstream.length).toBe(before);
  });
});
