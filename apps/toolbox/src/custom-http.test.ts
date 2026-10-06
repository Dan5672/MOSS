import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "./runners.js";

describe("custom_http (internal, sent by the gate)", () => {
  let server: Server;
  let port: number;
  const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.startsWith("/json")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }));
        if (req.url?.startsWith("/big")) return res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(2 * 1024 * 1024));
        if (req.url?.startsWith("/missing")) return res.writeHead(404, { "content-type": "text/plain" }).end("not here\u0007");
        res.writeHead(200, { "content-type": "text/plain" }).end("hello");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const req = (over: Record<string, unknown> = {}) => ({
    target: "127.0.0.1",
    port,
    scheme: "http",
    method: "GET",
    path: "/json?x=1",
    headers: { "X-Token": "secret-value" },
    verifyTls: true,
    timeoutMs: 5000,
    maxItems: 100,
    ...over,
  });

  it("sends exactly the rendered request and applies pick to JSON", async () => {
    const res = await runTool("custom_http", req({ method: "POST", body: '{"a":1}', headers: { "X-Token": "secret-value", "Content-Type": "application/json" }, pick: "$.items[*].name" }));
    expect(res).toEqual({ status: 200, ok: true, contentType: "application/json", data: ["a", "b"] });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/json?x=1", body: '{"a":1}' });
    expect(seen.at(-1)!.headers["x-token"]).toBe("secret-value");
  });

  it("returns non-JSON bodies as cleaned text and error statuses as data", async () => {
    expect(await runTool("custom_http", req({ path: "/missing" }))).toEqual({ status: 404, ok: false, contentType: "text/plain", text: "not here " });
  });

  it("caps large responses", async () => {
    const res = (await runTool("custom_http", req({ path: "/big" }))) as { text: string; truncated: boolean };
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBe(8 * 1024);
  });

  it("refuses requests the gate would never render", async () => {
    await expect(runTool("custom_http", req({ headers: { "X-Evil": "a\r\nHost: other" } }))).rejects.toThrow(/Invalid arguments/);
    await expect(runTool("custom_http", req({ target: "example.com" }))).rejects.toThrow(/Invalid arguments/);
    await expect(runTool("custom_http", req({ path: "relative" }))).rejects.toThrow(/Invalid arguments/);
    await expect(runTool("custom_http", req({ port: 1 }))).rejects.toThrow(/Request failed/);
  });
});
