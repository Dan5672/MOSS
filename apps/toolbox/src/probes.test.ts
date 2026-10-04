import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "./runners.js";
import { tlsInspect } from "./probes.js";

// Self-signed test certificate (CN=probe.test, SAN probe.test + 127.0.0.1). Test-only key.
const cert = readFileSync(new URL("./fixtures/probe-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/probe-key.pem", import.meta.url));

const listen = (s: Server | ReturnType<typeof createNetServer>) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

let httpPort = 0;
let httpsPort = 0;
let closedPort = 0;
const seenHosts: string[] = [];
const http = createHttpServer((req, res) => {
  seenHosts.push(req.headers.host ?? "");
  if (req.url === "/redirect") return res.writeHead(302, { location: "http://evil.example/" }).end();
  if (req.url === "/fail") return res.writeHead(503).end("down");
  res.writeHead(200, { "content-type": "text/plain" }).end("all systems nominal");
});
const https = createHttpsServer({ cert, key }, (_req, res) => res.writeHead(204).end());

beforeAll(async () => {
  httpPort = await listen(http);
  httpsPort = await listen(https);
  const tmp = createNetServer();
  closedPort = await listen(tmp);
  await new Promise((r) => tmp.close(r));
});
afterAll(() => {
  http.close();
  https.close();
});

describe("tcp_connect", () => {
  it("reports open and closed ports as results", async () => {
    expect(await runTool("tcp_connect", { target: "127.0.0.1", port: httpPort })).toMatchObject({ open: true });
    const closed = (await runTool("tcp_connect", { target: "127.0.0.1", port: closedPort })) as { open: boolean; error: string };
    expect(closed.open).toBe(false);
    expect(closed.error).toMatch(/ECONNREFUSED/);
  });

  it("refuses hostnames and CIDRs", async () => {
    await expect(runTool("tcp_connect", { target: "localhost", port: 80 })).rejects.toThrow(/Invalid arguments/);
    await expect(runTool("tcp_connect", { target: "127.0.0.0/8", port: 80 })).rejects.toThrow(/Invalid arguments/);
  });
});

describe("http_probe", () => {
  it("checks status and keyword, sending the host header", async () => {
    const ok = await runTool("http_probe", { target: "127.0.0.1", port: httpPort, keyword: "nominal", hostHeader: "nas.home.test" });
    expect(ok).toMatchObject({ ok: true, status: 200, keywordFound: true, url: `http://nas.home.test:${httpPort}/` });
    expect(seenHosts.at(-1)).toBe("nas.home.test");
    expect(await runTool("http_probe", { target: "127.0.0.1", port: httpPort, keyword: "absent" })).toMatchObject({ ok: false, keywordFound: false });
    expect(await runTool("http_probe", { target: "127.0.0.1", port: httpPort, path: "/fail" })).toMatchObject({ ok: false, status: 503 });
    expect(await runTool("http_probe", { target: "127.0.0.1", port: httpPort, path: "/fail", expectStatus: [503] })).toMatchObject({ ok: true });
  });

  it("does not follow redirects", async () => {
    const res = await runTool("http_probe", { target: "127.0.0.1", port: httpPort, path: "/redirect" });
    expect(res).toMatchObject({ status: 302, location: "http://evil.example/" });
    expect(seenHosts.filter((h) => h.includes("evil"))).toEqual([]);
  });

  it("reports connection failures and TLS verification", async () => {
    expect(await runTool("http_probe", { target: "127.0.0.1", port: closedPort })).toMatchObject({ ok: false });
    const untrusted = await runTool("http_probe", { target: "127.0.0.1", port: httpsPort, scheme: "https" });
    expect(untrusted).toMatchObject({ ok: false });
    expect(await runTool("http_probe", { target: "127.0.0.1", port: httpsPort, scheme: "https", verifyTls: false })).toMatchObject({ ok: true, status: 204 });
  });

  it("rejects paths with spaces or no leading slash", async () => {
    await expect(runTool("http_probe", { target: "127.0.0.1", path: "/a b" })).rejects.toThrow(/Invalid arguments/);
    await expect(runTool("http_probe", { target: "127.0.0.1", path: "@evil/" })).rejects.toThrow(/Invalid arguments/);
  });
});

describe("tls_inspect", () => {
  it("reads the certificate and days remaining", async () => {
    const res = await runTool("tls_inspect", { target: "127.0.0.1", port: httpsPort, servername: "probe.test" });
    expect(res).toMatchObject({ subject: "probe.test, MOSS Test", trusted: false, altNames: ["probe.test", "127.0.0.1"] });
    expect((res as { daysRemaining: number }).daysRemaining).toBeGreaterThan(30_000);
  });

  it("computes days remaining against the clock", async () => {
    const validTo = new Date(((await tlsInspect("127.0.0.1", httpsPort, undefined, 5000)) as { validTo: string }).validTo).getTime();
    const res = await tlsInspect("127.0.0.1", httpsPort, undefined, 5000, () => validTo - 5.5 * 86_400_000);
    expect(res.daysRemaining).toBe(5);
  });

  it("reports a port without TLS as an error result", async () => {
    const res = await tlsInspect("127.0.0.1", httpPort, undefined, 5000);
    expect(res.error).toBeTruthy();
    expect(res.trusted).toBe(false);
  });
});
