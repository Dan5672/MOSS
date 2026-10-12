import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendRequest } from "./custom-http.js";
import { checkPin, pinScope, type PinScope } from "./pins.js";

const cert = readFileSync(new URL("./fixtures/probe-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/probe-key.pem", import.meta.url));
const fingerprint = new X509Certificate(cert).fingerprint256;

describe("host pinning", () => {
  let server: Server;
  let port: number;
  const received: string[] = [];

  beforeAll(async () => {
    server = createServer({ cert, key }, (req, res) => {
      received.push(String(req.headers.authorization));
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const call = (scope: PinScope) =>
    pinScope.run(scope, () =>
      sendRequest({ target: "127.0.0.1", port, scheme: "https", method: "GET", path: "/", headers: { Authorization: "Bearer s3cret" }, verifyTls: false, timeoutMs: 5000, maxItems: 1 }),
    );

  it("learns a device's certificate on first use, and accepts it again", async () => {
    const first: PinScope = { known: {}, seen: {} };
    expect((await call(first)).status).toBe(200);
    expect(first.seen).toEqual({ [`tls:127.0.0.1:${port}`]: fingerprint });
    expect((await call({ known: first.seen, seen: {} })).status).toBe(200);
  });

  it("sends nothing to a device presenting a different certificate", async () => {
    received.length = 0;
    const scope: PinScope = { known: { [`tls:127.0.0.1:${port}`]: "AA:BB" }, seen: {} };
    await expect(call(scope)).rejects.toThrow(/different TLS certificate/);
    expect(received).toEqual([]);
    expect(scope.seen[`tls:127.0.0.1:${port}`]).toBe(fingerprint);
  });

  it("checks the certificate when the owner asks for it, whatever the tool said", async () => {
    await expect(call({ known: {}, seen: {}, verifyTls: true })).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
  });

  it("refuses plain HTTP to a device that has used HTTPS, so a credential can't be downgraded", async () => {
    const scope: PinScope = { known: { [`tls:127.0.0.1:${port}`]: fingerprint }, seen: {} };
    await expect(
      pinScope.run(scope, () =>
        sendRequest({ target: "127.0.0.1", port: 80, scheme: "http", method: "GET", path: "/", headers: { Authorization: "Bearer s3cret" }, verifyTls: false, timeoutMs: 2000, maxItems: 1 }),
      ),
    ).rejects.toThrow(/won't be sent over plain HTTP/);
  });
});

describe("pin keys", () => {
  const run = (scope: PinScope, fn: () => void) => pinScope.run(scope, fn);

  it("treat another spelling of an address as the same device", () => {
    const scope: PinScope = { known: { "tls:192.168.1.5:443": "AA" }, seen: {} };
    expect(() => run(scope, () => checkPin("tls", "::ffff:192.168.1.5", 443, "BB"))).toThrow(/different TLS certificate/);
    expect(scope.seen).toEqual({ "tls:192.168.1.5:443": "BB" });
  });

  it("only take a new port on a known device on trust with a key it already showed", () => {
    const scope: PinScope = { known: { "ssh:192.168.1.5:22": "SHA256:a" }, seen: {} };
    expect(() => run(scope, () => checkPin("ssh", "192.168.1.5", 2222, "SHA256:evil"))).toThrow(/new port/);
    expect(() => run(scope, () => checkPin("ssh", "192.168.1.5", 2222, "SHA256:a"))).not.toThrow();
    expect(() => run(scope, () => checkPin("ssh", "192.168.1.6", 22, "SHA256:new"))).not.toThrow(); // a new device: first use
  });

  it("accept a renewed certificate a trusted authority signed", () => {
    const scope: PinScope = { known: { "tls:192.168.1.5:443": "AA" }, seen: {}, verifyTls: true };
    expect(() => run(scope, () => checkPin("tls", "192.168.1.5", 443, "BB", { trusted: true }))).not.toThrow();
  });
});
