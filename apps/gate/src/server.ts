// Gate HTTP API, called only by the worker (agent runtime) with a service token.
import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import type { LlmProxy } from "./llm-proxy.js";
import type { Gate } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameToken(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function buildGateServer(gate: Gate, opts: { token: string; llmProxy?: LlmProxy; logger?: boolean }) {
  if (opts.token.length < 32) throw new Error("GATE_TOKEN must be at least 32 characters");
  // Large body limit for LLM requests (long agent transcripts); tool calls are small.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/v1/health") return;
    // SDKs send the service token as their "API key": Bearer for OpenAI-style clients, x-api-key for Anthropic.
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
    if (typeof presented !== "string" || !sameToken(presented, opts.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/v1/health", async () => ({ ok: true }));

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/tools", async (req, reply) => {
    if (!UUID.test(req.params.agentId)) return reply.code(400).send({ error: "invalid agent id" });
    return { tools: await gate.listAgentTools(req.params.agentId) };
  });

  app.post<{ Body: { agentId?: string; tool?: string; args?: unknown; changeId?: string; runId?: string } }>(
    "/v1/tool-calls",
    async (req, reply) => {
      const { agentId, tool, args, changeId, runId } = req.body ?? {};
      if (!agentId || !UUID.test(agentId) || typeof tool !== "string") {
        return reply.code(400).send({ error: "agentId (uuid) and tool are required" });
      }
      if ((changeId && !UUID.test(changeId)) || (runId && !UUID.test(runId))) {
        return reply.code(400).send({ error: "changeId and runId must be uuids" });
      }
      return gate.handleToolCall({ agentId, tool, args: args ?? {}, changeId, runId });
    },
  );

  if (opts.llmProxy) {
    const proxy = opts.llmProxy;
    app.route<{ Params: { providerId: string; "*": string } }>({
      method: ["GET", "POST"],
      url: "/v1/llm/:providerId/*",
      handler: async (req, reply) => {
        if (!UUID.test(req.params.providerId)) return reply.code(400).send({ error: "invalid provider id" });
        const res = await proxy({
          providerId: req.params.providerId,
          path: req.params["*"].split("?")[0]!,
          method: req.method,
          headers: req.headers,
          body: req.body,
        });
        reply.code(res.status).headers(res.headers);
        if (res.body === null) return reply.send();
        return reply.send(typeof res.body === "string" ? res.body : Readable.fromWeb(res.body as NodeWebStream<Uint8Array>));
      },
    });
  }

  return app;
}
