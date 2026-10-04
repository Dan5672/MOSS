// Service probes built on Node's own sockets: no binaries, no shell. Every probe connects to the
// literal IP it was given; hostnames are only sent as the Host header / TLS SNI.
// A failed connection is a result (the service is down), not a tool error.
import type { HttpProbeResult, TcpConnectResult, TlsInspectResult } from "@moss/tools";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";

const MAX_BODY = 256 * 1024;

const errorText = (err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  return (e.code ? `${e.code}: ` : "") + String(e.message ?? err).slice(0, 300);
};

export function tcpConnect(target: string, port: number, timeoutMs: number): Promise<TcpConnectResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = netConnect({ host: target, port });
    const done = (open: boolean, error?: string) => {
      socket.destroy();
      resolve({ target, port, open, latencyMs: Math.round(performance.now() - started), ...(error ? { error } : {}) });
    };
    socket.setTimeout(timeoutMs, () => done(false, `timed out after ${timeoutMs} ms`));
    socket.once("connect", () => done(true));
    socket.once("error", (err) => done(false, errorText(err)));
  });
}

export interface HttpProbeArgs {
  target: string;
  port?: number;
  scheme: "http" | "https";
  path: string;
  hostHeader?: string;
  method: "GET" | "HEAD";
  expectStatus?: number[];
  keyword?: string;
  verifyTls: boolean;
  timeoutMs: number;
}

export function httpProbe(a: HttpProbeArgs): Promise<HttpProbeResult> {
  const port = a.port ?? (a.scheme === "https" ? 443 : 80);
  const hostForUrl = a.hostHeader ?? (a.target.includes(":") ? `[${a.target}]` : a.target);
  const url = `${a.scheme}://${hostForUrl}:${port}${a.path}`;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const request = a.scheme === "https" ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Omit<HttpProbeResult, "url" | "latencyMs">) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ url, latencyMs: elapsed(), ...r });
    };
    const req = request({
      host: a.target,
      port,
      path: a.path,
      method: a.method,
      headers: { "user-agent": "MOSS-monitor/1", accept: "*/*", ...(a.hostHeader ? { host: a.hostHeader } : {}) },
      ...(a.scheme === "https" ? { servername: a.hostHeader, rejectUnauthorized: a.verifyTls } : {}),
      timeout: a.timeoutMs,
    });
    req.on("timeout", () => finish({ ok: false, error: `timed out after ${a.timeoutMs} ms` }));
    req.on("error", (err) => finish({ ok: false, error: errorText(err) }));
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const statusOk = a.expectStatus?.length ? a.expectStatus.includes(status) : status >= 200 && status < 400;
      const location = typeof res.headers.location === "string" ? res.headers.location.slice(0, 500) : undefined;
      if (!a.keyword || a.method === "HEAD") {
        res.resume();
        return finish({ ok: statusOk, status, ...(location ? { location } : {}) });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const check = () => {
        const found = Buffer.concat(chunks).toString("utf8").includes(a.keyword!);
        finish({ ok: statusOk && found, status, keywordFound: found, ...(location ? { location } : {}) });
      };
      res.on("data", (chunk: Buffer) => {
        if (size >= MAX_BODY) return;
        chunks.push(chunk.subarray(0, MAX_BODY - size));
        size += chunk.length;
        if (size >= MAX_BODY) check();
      });
      res.on("end", check);
      res.on("error", (err) => finish({ ok: false, status, error: errorText(err) }));
    });
    req.end();
  });
}

const DAY_MS = 86_400_000;

function nameOf(field: PeerCertificate["subject"] | undefined): string | undefined {
  if (!field) return undefined;
  const cn = field.CN;
  const o = field.O;
  return [Array.isArray(cn) ? cn[0] : cn, Array.isArray(o) ? o[0] : o].filter(Boolean).join(", ").slice(0, 300) || undefined;
}

export function tlsInspect(target: string, port: number, servername: string | undefined, timeoutMs: number, now = () => Date.now()): Promise<TlsInspectResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = tlsConnect({ host: target, port, servername, rejectUnauthorized: false });
    const finish = (r: Omit<TlsInspectResult, "target" | "port" | "latencyMs">) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ target, port, latencyMs: Math.round(performance.now() - started), ...r });
    };
    socket.setTimeout(timeoutMs, () => finish({ altNames: [], trusted: false, error: `timed out after ${timeoutMs} ms` }));
    socket.once("error", (err) => finish({ altNames: [], trusted: false, error: errorText(err) }));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) return finish({ altNames: [], trusted: false, error: "no certificate presented" });
      const validTo = new Date(cert.valid_to);
      const altNames = (cert.subjectaltname ?? "")
        .split(/,\s*/)
        .map((s) => s.replace(/^(DNS|IP Address):/, ""))
        .filter(Boolean)
        .slice(0, 50);
      finish({
        subject: nameOf(cert.subject),
        issuer: nameOf(cert.issuer),
        altNames,
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: validTo.toISOString(),
        daysRemaining: Math.floor((validTo.getTime() - now()) / DAY_MS),
        trusted: socket.authorized,
        ...(socket.authorizationError ? { trustError: String(socket.authorizationError) } : {}),
      });
    });
  });
}
