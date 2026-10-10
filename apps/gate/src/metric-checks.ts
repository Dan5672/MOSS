// Metric monitor checks: SNMP (one interface's traffic, or an OID), host stats over SSH, and Home Assistant
// sensors. They run through the same policy-checked caller as the other monitor checks (monitor-check.ts);
// thresholds are applied there afterwards.
import { counterRates, interfaceOids, type CheckResult } from "@moss/core";
import type { monitors } from "@moss/db";
import type { SnmpResult } from "@moss/tools";

export type Monitor = typeof monitors.$inferSelect;
export type Call<T> = { ok: true; result: T } | { ok: false; result: CheckResult };
/** A credential argument: which tool argument takes it, and the stored secret's name. */
export type SecretArg = { arg: string; name: string };
export type Caller = <T>(tool: string, args: Record<string, unknown>, secret?: SecretArg) => Promise<Call<T>>;

const num = (v: string | undefined) => (v !== undefined && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined);
const round = (n: number) => Math.round(n * 100) / 100;

export function fmtBps(n: number | undefined) {
  if (n === undefined) return "?";
  const steps = ["bps", "kbps", "Mbps", "Gbps"];
  let i = 0;
  while (n >= 1000 && i < steps.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${steps[i]}`;
}

/** One interface's traffic (bits per second), errors per minute and status; or one OID's value or rate. */
export async function snmpCheck(m: Monitor, ip: string, timeoutMs: number, now: Date, call: Caller): Promise<CheckResult> {
  const c = m.config;
  const secret = { arg: "community", name: c.secret ?? "" };
  if (c.ifIndex) {
    const o = interfaceOids(c.ifIndex);
    const res = await call<SnmpResult>("snmp_query", { target: ip, preset: "get", oids: Object.values(o), timeoutMs }, secret);
    if (!res.ok) return res.result;
    const v = res.result.values;
    const label = v[o.name] || `interface ${c.ifIndex}`;
    if (v[o.status] === undefined) return { ok: false, message: `${ip} has no interface ${c.ifIndex}` };
    const counters: Record<string, number> = {};
    for (const k of ["inOctets", "outOctets", "inErrors", "outErrors"] as const) {
      const n = num(v[o[k]]);
      if (n !== undefined) counters[k] = n;
    }
    const r = counterRates(m.lastResult?.counters, m.lastResult?.at, counters, now);
    const values: Record<string, number> = {};
    if (r.inOctets !== undefined) values.inBps = round(r.inOctets * 8);
    if (r.outOctets !== undefined) values.outBps = round(r.outOctets * 8);
    if (r.inErrors !== undefined) values.inErrorsPerMin = round(r.inErrors * 60);
    if (r.outErrors !== undefined) values.outErrorsPerMin = round(r.outErrors * 60);
    const up = v[o.status] === "1";
    const measured = values.inBps !== undefined || values.outBps !== undefined;
    const busiest = measured ? Math.max(values.inBps ?? 0, values.outBps ?? 0) : null;
    const traffic = measured ? `in ${fmtBps(values.inBps)}, out ${fmtBps(values.outBps)}` : "measuring traffic (needs two checks)";
    return { ok: up, value: busiest, values, unit: "bps", counters, message: up ? `${label} up, ${traffic}` : `${label} is down` };
  }
  const oid = (c.oid ?? "").replace(/^\./, "");
  const res = await call<SnmpResult>("snmp_query", { target: ip, preset: "get", oids: [oid], timeoutMs }, secret);
  if (!res.ok) return res.result;
  const raw = res.result.values[oid];
  const n = num(raw);
  if (n === undefined) return { ok: false, message: raw === undefined ? `No value at ${oid}` : `${oid} isn't a number: ${raw.slice(0, 60)}` };
  if (!c.counter) return { ok: true, value: n, values: { value: n }, unit: c.unit, message: `${oid} = ${n}${c.unit ? ` ${c.unit}` : ""}` };
  const rate = counterRates(m.lastResult?.counters, m.lastResult?.at, { value: n }, now).value;
  return {
    ok: true,
    value: rate === undefined ? null : round(rate),
    values: rate === undefined ? {} : { value: round(rate) },
    unit: c.unit ? `${c.unit}/s` : "/s",
    counters: { value: n },
    message: rate === undefined ? `${oid}: measuring the rate (needs two checks)` : `${oid}: ${round(rate)} per second`,
  };
}

interface HostFactsResult {
  cpus?: number;
  memoryGb?: { total?: number; available?: number };
  load?: Record<"1m" | "5m" | "15m", number>;
}
interface DiskUsageResult {
  fullest?: { mount: string; usedPercent: number };
}

/** Load, memory and the fullest disk, over SSH with the stored key. */
export async function hostCheck(m: Monitor, ip: string, timeoutMs: number, call: Caller): Promise<CheckResult> {
  const c = m.config;
  const ssh = { target: ip, user: c.user, port: c.port ?? 22, ...(c.hostKeySha256 ? { hostKeySha256: c.hostKeySha256 } : {}), timeoutMs };
  const secret = { arg: "key", name: c.secret ?? "" };
  const facts = await call<HostFactsResult>("host_facts", ssh, secret);
  if (!facts.ok) return facts.result;
  const disks = await call<DiskUsageResult>("disk_usage", ssh, secret);
  if (!disks.ok) return disks.result;
  const f = facts.result;
  const values: Record<string, number> = {};
  if (f.load) Object.assign(values, { load1: f.load["1m"], load5: f.load["5m"], load15: f.load["15m"] });
  if (f.cpus) values.cpus = f.cpus;
  const mem = f.memoryGb;
  if (mem?.total && mem.available !== undefined) values.memUsedPercent = round(((mem.total - mem.available) / mem.total) * 100);
  const fullest = disks.result.fullest;
  if (fullest) values.diskUsedPercent = fullest.usedPercent;
  const parts = [
    values.load1 !== undefined ? `load ${values.load1}${values.cpus ? ` on ${values.cpus} CPUs` : ""}` : null,
    values.memUsedPercent !== undefined ? `memory ${Math.round(values.memUsedPercent)}%` : null,
    fullest ? `${fullest.mount} ${fullest.usedPercent}% full` : null,
  ].filter(Boolean);
  return { ok: true, value: values.memUsedPercent ?? null, values, unit: "%", message: parts.join(", ") || "connected" };
}

const BINARY: Record<string, number> = { on: 1, off: 0, open: 1, closed: 0, home: 1, not_home: 0, true: 1, false: 0 };

/** A Home Assistant entity's state (from the integration's state op): a number with its unit, or on/off as 1/0. */
export function haSensorResult(m: Monitor, entity: { state?: string; unit?: string; name?: string } | undefined): CheckResult {
  if (!entity) return { ok: false, message: `Home Assistant has no ${m.target}` };
  const name = entity.name ?? m.target;
  const state = (entity.state ?? "").trim();
  if (state === "unavailable" || state === "unknown" || !state) return { ok: false, message: `${name} is ${state || "empty"}` };
  const n = num(state) ?? BINARY[state.toLowerCase()];
  const unit = m.config.unit ?? entity.unit ?? undefined;
  if (n === undefined) return { ok: true, message: `${name}: ${state}` };
  return { ok: true, value: n, values: { value: n }, unit, message: `${name}: ${state}${unit ? ` ${unit}` : ""}` };
}
