// Gate HTTP API. Three callers, three tokens, disjoint routes:
//   worker (GATE_TOKEN):   tool calls, tool listing, monitor checks, module calls, LLM proxy
//   web    (WEB_TOKEN):    write-only secrets API, config backup downloads, a person's module calls (/v1/web/...)
//   bridge (BRIDGE_TOKEN): the Telegram and Discord bot tokens (/v1/bridge/...)
import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { z } from "zod";
import type { LlmProxy } from "./llm-proxy.js";
import { secretWriteSchema, type SecretWrite } from "./secrets-api.js";
import { HA_OPS, type HaOp } from "./home-assistant.js";
import type { Gate } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameToken(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export interface GateServerOptions {
  token: string;
  llmProxy?: LlmProxy;
  /** Enables the secrets API, authenticated with its own token. */
  secrets?: {
    token: string;
    write: (input: SecretWrite) => Promise<{ id: string; created: boolean }>;
    /** Decrypts a config backup for a person's download (audited by the callee). */
    readBackup?: (backupId: string, userId: string) => Promise<{ filename: string; contentType: string; content: Buffer } | null>;
    /** The org of an active user, for a person's module calls. */
    userOrg?: (userId: string) => Promise<string | null>;
  };
  /** The chat bridge's bot tokens, authenticated with its own token. */
  bridge?: { token: string; credentials: () => Promise<{ orgId: string; platform: string; token: string }[]> };
  logger?: boolean;
}

export function buildGateServer(gate: Gate, opts: GateServerOptions) {
  if (opts.token.length < 32) throw new Error("GATE_TOKEN must be at least 32 characters");
  if (opts.secrets && opts.secrets.token.length < 32) throw new Error("WEB_TOKEN must be at least 32 characters");
  if (opts.secrets && sameToken(opts.secrets.token, opts.token)) throw new Error("WEB_TOKEN must differ from GATE_TOKEN");
  if (opts.bridge && (opts.bridge.token.length < 32 || sameToken(opts.bridge.token, opts.token) || (opts.secrets && sameToken(opts.bridge.token, opts.secrets.token)))) {
    throw new Error("BRIDGE_TOKEN must be at least 32 characters and differ from the other tokens");
  }
  // Large body limit for LLM requests (long agent transcripts); tool calls are small.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    // The route the router matched, not the raw URL: the router decodes "/v1/%62ridge/..." to the bridge route,
    // so a check on the raw URL would accept the worker's token there.
    const route = req.routeOptions.url ?? "";
    if (route === "/v1/health") return;
    // SDKs send the service token as their "API key": Bearer for OpenAI-style clients, x-api-key for Anthropic.
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
    const webRoute = route.startsWith("/v1/secrets") || route.startsWith("/v1/backups") || route.startsWith("/v1/web/");
    const bridgeRoute = route.startsWith("/v1/bridge/");
    const expected = bridgeRoute ? opts.bridge?.token : webRoute ? opts.secrets?.token : opts.token;
    if (typeof presented !== "string" || !expected || !sameToken(presented, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  if (opts.secrets) {
    const secretsApi = opts.secrets;
    app.post("/v1/secrets", async (req, reply) => {
      const parsed = secretWriteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) });
      try {
        return await secretsApi.write(parsed.data);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
  }

  if (opts.secrets?.readBackup) {
    const readBackup = opts.secrets.readBackup;
    app.get<{ Params: { id: string }; Querystring: { userId?: string } }>("/v1/backups/:id", async (req, reply) => {
      const { id } = req.params;
      const userId = req.query.userId;
      if (!UUID.test(id) || !userId || !UUID.test(userId)) return reply.code(400).send({ error: "backup id and userId (uuids) are required" });
      const backup = await readBackup(id, userId);
      if (!backup) return reply.code(404).send({ error: "no such backup" });
      const safeName = backup.filename.replace(/[^A-Za-z0-9._-]/g, "_");
      return reply.header("content-type", backup.contentType).header("content-disposition", `attachment; filename="${safeName}"`).send(backup.content);
    });
  }

  // A person's Home Assistant calls from the module page: testing the connection, syncing the inventory now.
  if (opts.secrets?.userOrg) {
    const userOrg = opts.secrets.userOrg;
    app.post<{ Params: { op: string }; Body: { userId?: string } }>("/v1/web/modules/home-assistant/:op", async (req, reply) => {
      const op = req.params.op as HaOp;
      if (op !== "test" && op !== "devices") return reply.code(404).send({ error: "unknown operation" });
      const userId = req.body?.userId;
      if (!userId || !UUID.test(userId)) return reply.code(400).send({ error: "userId (uuid) is required" });
      const orgId = await userOrg(userId);
      if (!orgId) return reply.code(403).send({ error: "unknown or inactive user" });
      return gate.homeAssistant({ orgId, op, userId });
    });

    // Someone signing in with Microsoft or Google (not signed in yet, so no user: the web app names the org).
    app.post<{ Params: { provider: string }; Body: { orgId?: string; code?: string; redirectUri?: string; codeVerifier?: string } }>("/v1/web/sso/:provider/exchange", async (req, reply) => {
      const provider = req.params.provider;
      if (provider !== "microsoft" && provider !== "google") return reply.code(404).send({ error: "unknown provider" });
      const { orgId, code, redirectUri, codeVerifier } = req.body ?? {};
      if (!orgId || !UUID.test(orgId) || !code || !redirectUri || !codeVerifier) return reply.code(400).send({ error: "orgId, code, redirectUri and codeVerifier are required" });
      return gate.sso({ orgId, provider, code, redirectUri, codeVerifier });
    });

    // A person checking for MOSS updates (Settings → About): the newest release tags, fetched through the toolbox.
    app.post<{ Body: { userId?: string } }>("/v1/web/releases", async (req, reply) => {
      const userId = req.body?.userId;
      if (!userId || !UUID.test(userId)) return reply.code(400).send({ error: "userId (uuid) is required" });
      if (!(await userOrg(userId))) return reply.code(403).send({ error: "unknown or inactive user" });
      return gate.releases();
    });

    // A person's integration calls from its settings page: Test connection, and Sync now (sync:<feature>).
    app.post<{ Params: { key: string; op: string }; Body: { userId?: string } }>("/v1/web/integrations/:key/:op", async (req, reply) => {
      const { key, op } = req.params;
      if (op !== "test" && !op.startsWith("sync:")) return reply.code(404).send({ error: "unknown operation" });
      const userId = req.body?.userId;
      if (!userId || !UUID.test(userId)) return reply.code(400).send({ error: "userId (uuid) is required" });
      const orgId = await userOrg(userId);
      if (!orgId) return reply.code(403).send({ error: "unknown or inactive user" });
      return gate.integration({ orgId, key, op, userId });
    });
  }

  app.get("/v1/health", async () => ({ ok: true }));

  if (opts.bridge) {
    const bridge = opts.bridge;
    app.get("/v1/bridge/credentials", async () => ({ bots: await bridge.credentials() }));
  }

  // The worker's integration calls: health checks and inventory syncs.
  app.post<{ Params: { key: string; op: string }; Body: { orgId?: string; args?: Record<string, unknown> } }>("/v1/integrations/:key/:op", async (req, reply) => {
    const { key, op } = req.params;
    if (op === "test" || op.startsWith("sync:")) return reply.code(404).send({ error: "unknown operation" });
    const orgId = req.body?.orgId;
    if (!orgId || !UUID.test(orgId)) return reply.code(400).send({ error: "orgId (uuid) is required" });
    return gate.integration({ orgId, key, op, ...(req.body?.args ? { args: req.body.args } : {}) });
  });

  // The worker's Home Assistant calls: health checks, inventory sync, notifications, MOSS's sensors.
  app.post<{ Params: { op: string }; Body: { orgId?: string; args?: Record<string, unknown> } }>("/v1/modules/home-assistant/:op", async (req, reply) => {
    const op = req.params.op as HaOp;
    if (!HA_OPS.includes(op) || op === "test") return reply.code(404).send({ error: "unknown operation" });
    const orgId = req.body?.orgId;
    if (!orgId || !UUID.test(orgId)) return reply.code(400).send({ error: "orgId (uuid) is required" });
    const args = req.body?.args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return reply.code(400).send({ error: "args must be an object" });
    return gate.homeAssistant({ orgId, op, args });
  });

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

  app.post<{ Body: { monitorId?: string } }>("/v1/monitor-checks", async (req, reply) => {
    const monitorId = req.body?.monitorId;
    if (!monitorId || !UUID.test(monitorId)) return reply.code(400).send({ error: "monitorId (uuid) is required" });
    const result = await gate.checkMonitor(monitorId);
    if (!result) return reply.code(404).send({ error: "no such built-in monitor" });
    return result;
  });

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
