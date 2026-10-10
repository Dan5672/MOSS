// A minimal MCP server (streamable HTTP, JSON responses) that offers one run's tools to the Claude
// Code CLI. It listens on 127.0.0.1 only, requires a per-run bearer token, and implements just the
// methods a tool client needs: initialize, ping, tools/list, tools/call.
import type { ToolSpec } from "@moss/llm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpToolServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

const MAX_BODY = 1024 * 1024;
const PROTOCOL_VERSION = "2025-06-18";

const digest = (s: string) => createHash("sha256").update(s).digest();

export async function startMcpToolServer(opts: {
  tools: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  name?: string;
}): Promise<McpToolServer> {
  const token = randomBytes(32).toString("hex");
  const expected = digest(`Bearer ${token}`);
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!timingSafeEqual(digest(String(req.headers.authorization ?? "")), expected)) return send(res, 401);
    if (req.method === "DELETE") return send(res, 200);
    if (req.method !== "POST") return send(res, 405); // no server-initiated stream

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return send(res, 413);
    }
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(body);
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      return send(res, 400, rpcError(null, -32600, "Invalid request"));
    }
    if (msg.id === undefined) return send(res, 202); // notification
    const reply = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });

    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name ?? "moss", version: "1" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (typeof name !== "string" || !byName.has(name)) return reply({ content: [{ type: "text", text: `Unknown tool ${String(name)}` }], isError: true });
        if (typeof args !== "object" || Array.isArray(args)) return reply({ content: [{ type: "text", text: "Arguments must be an object" }], isError: true });
        try {
          const r = await opts.call(name, args as Record<string, unknown>);
          return reply({ content: [{ type: "text", text: r.text }], isError: r.isError });
        } catch (err) {
          return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      }
      default:
        return send(res, 200, rpcError(msg.id, -32601, `Method ${msg.method} not supported`));
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
