// Monitor checks. The worker only names a monitor; everything else (target, tool, arguments) is
// read from the database here, resolved to an IP, scope-checked with the same network rules as
// agent calls, and only then sent to the toolbox. Hostnames never reach a probe as a target.
import { isHostIp, writeAudit, type CheckResult } from "@moss/core";
import { monitors, networks, type Database } from "@moss/db";
import { evaluateMonitorCheck, type NetworkRule } from "@moss/policy";
import {
  BUILT_IN_TOOLS,
  parseToolArgs,
  type DnsLookupResult,
  type HttpProbeResult,
  type PingResult,
  type TcpConnectResult,
  type TlsInspectResult,
  type ToolDefinition,
} from "@moss/tools";
import { eq } from "drizzle-orm";
import type { ToolboxClient } from "./toolbox-client.js";

export interface MonitorCheckDeps {
  db: Database;
  toolbox: ToolboxClient;
  tools?: ReadonlyMap<string, ToolDefinition>;
}

type Monitor = typeof monitors.$inferSelect;
type Call<T> = { ok: true; result: T } | { ok: false; result: CheckResult };

const ms = (n: number | null | undefined) => (typeof n === "number" ? `${Math.round(n)} ms` : "");

export async function runMonitorCheck(deps: MonitorCheckDeps, monitorId: string): Promise<CheckResult | null> {
  const tools = deps.tools ?? BUILT_IN_TOOLS;
  const [m] = await deps.db.select().from(monitors).where(eq(monitors.id, monitorId));
  if (!m || m.kind === "external") return null;
  const rules: NetworkRule[] = await deps.db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, m.orgId));
  const timeoutMs = Math.min(30_000, Math.max(1_000, m.timeoutSeconds * 1000));

  async function call<T>(tool: string, rawArgs: Record<string, unknown>): Promise<Call<T>> {
    const def = tools.get(tool);
    if (!def) return { ok: false, result: { ok: false, message: `Tool ${tool} is not available` } };
    const parsed = parseToolArgs(def, rawArgs);
    if (!parsed.ok) return { ok: false, result: { ok: false, message: `Invalid check settings: ${parsed.error}`.slice(0, 500) } };
    const decision = evaluateMonitorCheck({ tool, args: parsed.args }, def.manifest, rules);
    if (!decision.allow) {
      // Audit the first denial, not every repeat of it.
      if (!m!.lastResult?.policyDenied) {
        await writeAudit(deps.db, {
          orgId: m!.orgId,
          siteId: m!.siteId,
          actorType: "system",
          action: "monitor.check_denied",
          targetType: "monitor",
          targetId: m!.id,
          details: { tool, code: decision.code, reason: decision.reason, args: parsed.args },
        });
      }
      return { ok: false, result: { ok: false, policyDenied: true, message: `Blocked by policy: ${decision.reason}` } };
    }
    try {
      const res = await deps.toolbox.call(tool, parsed.args);
      if (!res.ok) return { ok: false, result: { ok: false, message: (res.error ?? "check failed").slice(0, 500) } };
      return { ok: true, result: res.result as T };
    } catch (err) {
      return { ok: false, result: { ok: false, message: `Toolbox unavailable: ${(err as Error).message}`.slice(0, 500) } };
    }
  }

  // DNS monitors check the resolver itself; there is no target to scope-check.
  if (m.kind === "dns") {
    const type = m.config.recordType ?? "A";
    const res = await call<DnsLookupResult>("dns_lookup", { name: m.target, type });
    if (!res.ok) return res.result;
    const answers = res.result.answers;
    if (!answers.length) return { ok: false, message: `${m.target} ${type}: no answer` };
    if (m.config.expectAnswer && !answers.includes(m.config.expectAnswer)) {
      return { ok: false, message: `${m.target} ${type}: ${answers.slice(0, 4).join(", ")} (expected ${m.config.expectAnswer})` };
    }
    return { ok: true, message: `${m.target} ${type}: ${answers.slice(0, 4).join(", ")}` };
  }

  // Resolve hostnames once, here, and probe the IP: a DNS answer can't move the probe after the scope check.
  let ip = m.target;
  const hostname = isHostIp(m.target) ? undefined : m.target.replace(/\.$/, "");
  if (hostname) {
    let resolved: string | undefined;
    for (const type of ["A", "AAAA"] as const) {
      const res = await call<DnsLookupResult>("dns_lookup", { name: hostname, type });
      if (!res.ok) return res.result;
      resolved = res.result.answers[0];
      if (resolved) break;
    }
    if (!resolved) return { ok: false, message: `Could not resolve ${hostname}` };
    ip = resolved;
  }

  const result = await probe(m, ip, hostname, timeoutMs, call);
  if (result.ok && !result.degraded && m.config.degradedMs && (result.latencyMs ?? 0) > m.config.degradedMs) {
    return { ...result, degraded: true, message: `${result.message} (slower than ${m.config.degradedMs} ms)` };
  }
  return result;
}

async function probe(
  m: Monitor,
  ip: string,
  hostname: string | undefined,
  timeoutMs: number,
  call: <T>(tool: string, args: Record<string, unknown>) => Promise<Call<T>>,
): Promise<CheckResult> {
  const c = m.config;
  switch (m.kind) {
    case "ping": {
      const res = await call<PingResult>("ping", { target: ip, count: 3 });
      if (!res.ok) return res.result;
      const r = res.result;
      const ok = r.received > 0;
      return { ok, degraded: ok && r.lossPercent > 0, latencyMs: r.rttAvgMs ?? null, message: ok ? `${r.received}/${r.transmitted} replies, ${ms(r.rttAvgMs)}` : `No replies from ${ip}` };
    }
    case "tcp": {
      const res = await call<TcpConnectResult>("tcp_connect", { target: ip, port: c.port, timeoutMs });
      if (!res.ok) return res.result;
      const r = res.result;
      return { ok: r.open, latencyMs: r.latencyMs, message: r.open ? `Port ${c.port} open, ${ms(r.latencyMs)}` : `Port ${c.port}: ${r.error ?? "closed"}` };
    }
    case "http": {
      const res = await call<HttpProbeResult>("http_probe", {
        target: ip,
        port: c.port,
        scheme: c.scheme ?? "http",
        path: c.path ?? "/",
        hostHeader: hostname,
        method: c.method ?? "GET",
        expectStatus: c.expectStatus,
        keyword: c.keyword,
        verifyTls: c.verifyTls ?? true,
        timeoutMs,
      });
      if (!res.ok) return res.result;
      const r = res.result;
      if (r.error) return { ok: false, latencyMs: r.latencyMs, message: r.error };
      const keyword = r.keywordFound === false ? `, keyword "${c.keyword}" not found` : "";
      return { ok: r.ok, latencyMs: r.latencyMs, message: `HTTP ${r.status}${keyword}, ${ms(r.latencyMs)}` };
    }
    case "tls": {
      const res = await call<TlsInspectResult>("tls_inspect", { target: ip, port: c.port ?? 443, servername: hostname, timeoutMs });
      if (!res.ok) return res.result;
      const r = res.result;
      if (r.error) return { ok: false, latencyMs: r.latencyMs, message: r.error };
      const days = r.daysRemaining ?? -1;
      if (days < 0) return { ok: false, latencyMs: r.latencyMs, message: `Certificate expired ${r.validTo}` };
      if ((c.verifyTls ?? true) && !r.trusted) return { ok: false, latencyMs: r.latencyMs, message: `Certificate not trusted: ${r.trustError ?? "unknown issuer"}` };
      const warn = c.warnDays ?? 14;
      return { ok: true, degraded: days < warn, latencyMs: r.latencyMs, message: `Certificate for ${r.subject ?? "?"} expires in ${days} days` };
    }
    default:
      return { ok: false, message: `Unsupported monitor kind ${m.kind}` };
  }
}
