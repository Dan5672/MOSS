// Toolbox HTTP API. Only the gate holds the token; agents never talk to the toolbox.
import { BUILT_IN_TOOLS, toolInputSchema } from "@moss/tools";
import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { defaultExec, runTool, ToolError, type Exec } from "./runners.js";

function sameToken(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function buildToolboxServer(opts: { token: string; exec?: Exec; logger?: boolean }) {
  if (opts.token.length < 32) throw new Error("TOOLBOX_TOKEN must be at least 32 characters");
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/v1/health") return;
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !sameToken(header.slice(7), opts.token)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  app.get("/v1/health", async () => ({ ok: true }));

  app.get("/v1/tools", async () => ({
    tools: [...BUILT_IN_TOOLS.values()].map((d) => ({ ...d.manifest, description: d.description, inputSchema: toolInputSchema(d) })),
  }));

  app.post<{ Params: { name: string }; Body: { args?: unknown } }>("/v1/tools/:name", async (req, reply) => {
    const started = Date.now();
    try {
      const result = await runTool(req.params.name, req.body?.args, opts.exec ?? defaultExec);
      return { ok: true, result, durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof ToolError) return reply.code(422).send({ ok: false, error: err.message, durationMs: Date.now() - started });
      req.log.error(err);
      return reply.code(500).send({ ok: false, error: "internal toolbox error" });
    }
  });

  return app;
}
