// Read-only calls to home lab products' own APIs: Proxmox VE, TrueNAS, Synology DSM, Home Assistant,
// Pi-hole (v6) and AdGuard Home. Requests go to the literal target IP; everything returned is device data
// and is cleaned and summarised here before it reaches an agent.
import type { RenderedRequest } from "@moss/tools";
import { sendRequest, type RawRequest } from "./custom-http.js";
import { clean } from "./parsers.js";

export class HomelabError extends Error {}

export interface Base {
  target: string;
  port: number;
  verifyTls: boolean;
  timeoutMs: number;
  scheme?: "http" | "https";
}

export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const gb = (bytes: unknown) => {
  const n = num(bytes);
  return n === undefined ? undefined : Math.round(n / 1e7) / 100;
};
const pct = (part: unknown, whole: unknown) => {
  const a = num(part);
  const b = num(whole);
  return a === undefined || !b ? undefined : Math.round((a / b) * 1000) / 10;
};

/** One JSON API call; 401/403 become a clear "credentials rejected" error naming the product. */
export async function call(
  send: RawRequest,
  product: string,
  b: Base,
  method: RenderedRequest["method"],
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  let res;
  try {
    res = await send({
      target: b.target,
      port: b.port,
      scheme: b.scheme ?? "https",
      method,
      path,
      headers: { Accept: "application/json", ...headers },
      body,
      verifyTls: b.verifyTls,
      timeoutMs: b.timeoutMs,
      maxItems: 1,
    });
  } catch (err) {
    throw new HomelabError(`Could not reach ${product} at ${b.target}:${b.port}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new HomelabError(`${product} rejected the credentials (HTTP ${res.status})`);
  if (res.truncated) throw new HomelabError(`${product}'s answer was too large`);
  let json: unknown;
  const text = res.body.toString("utf8");
  // A successful write may answer with no body at all (e.g. 204 No Content).
  if (!text.trim() && res.status < 400) return { status: res.status, json: null };
  try {
    json = JSON.parse(text);
  } catch {
    throw new HomelabError(`${product} answered HTTP ${res.status} with something that isn't JSON (is this the right port?)`);
  }
  if (res.status >= 400) throw new HomelabError(`${product} answered HTTP ${res.status}`);
  return { status: res.status, json };
}

export const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// --- Proxmox VE ---------------------------------------------------------------------------------

export async function proxmoxStatus(a: Base & { token: string }, send: RawRequest = sendRequest) {
  if (!/^[^\s=]+@[^\s=]+![^\s=]+=[^\s]+$/.test(a.token)) throw new HomelabError("The Proxmox token should look like USER@REALM!TOKENID=SECRET");
  const { json } = await call(send, "Proxmox", a, "GET", "/api2/json/cluster/resources", { Authorization: `PVEAPIToken=${a.token}` });
  const items = arr(obj(json).data);
  return {
    nodes: items
      .filter((r) => r.type === "node")
      .map((r) => ({ node: clean(r.node), status: clean(r.status), cpuPercent: pct(r.cpu, 1), memoryPercent: pct(r.mem, r.maxmem), diskPercent: pct(r.disk, r.maxdisk), uptimeDays: num(r.uptime) ? Math.round((num(r.uptime)! / 86400) * 10) / 10 : undefined })),
    guests: items
      .filter((r) => r.type === "qemu" || r.type === "lxc")
      .slice(0, 300)
      .map((r) => ({ id: num(r.vmid), name: clean(r.name), kind: r.type === "qemu" ? "vm" : "container", node: clean(r.node), status: clean(r.status), cpuPercent: pct(r.cpu, 1), memoryPercent: pct(r.mem, r.maxmem) })),
    storage: items
      .filter((r) => r.type === "storage")
      .slice(0, 100)
      .map((r) => ({ storage: clean(r.storage), node: clean(r.node), status: clean(r.status), usedPercent: pct(r.disk, r.maxdisk), sizeGb: gb(r.maxdisk) })),
  };
}

// --- TrueNAS ------------------------------------------------------------------------------------

export async function truenasStatus(a: Base & { apiKey: string }, send: RawRequest = sendRequest) {
  const h = { Authorization: `Bearer ${a.apiKey}` };
  const [info, pools, alerts] = await Promise.all([
    call(send, "TrueNAS", a, "GET", "/api/v2.0/system/info", h),
    call(send, "TrueNAS", a, "GET", "/api/v2.0/pool", h),
    call(send, "TrueNAS", a, "GET", "/api/v2.0/alert/list", h),
  ]);
  const i = obj(info.json);
  return {
    hostname: clean(i.hostname),
    version: clean(i.version),
    uptimeDays: num(i.uptime_seconds) ? Math.round((num(i.uptime_seconds)! / 86400) * 10) / 10 : undefined,
    pools: arr(pools.json).map((p) => ({ name: clean(p.name), status: clean(p.status), healthy: p.healthy === true })),
    alerts: arr(alerts.json)
      .filter((x) => x.dismissed !== true)
      .slice(0, 50)
      .map((x) => ({ level: clean(x.level), message: clean(x.formatted) ?? clean(x.text) })),
  };
}

// --- Synology DSM -------------------------------------------------------------------------------

export async function synologyStatus(a: Base & { user: string; password: string }, send: RawRequest = sendRequest) {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
  const login = await call(send, "Synology", a, "POST", "/webapi/entry.cgi", formHeaders, form({ api: "SYNO.API.Auth", version: "6", method: "login", account: a.user, passwd: a.password, format: "sid" }));
  const sid = clean(obj(obj(login.json).data).sid);
  if (obj(login.json).success !== true || !sid) throw new HomelabError("Synology refused the login (check the account, password and 2-step verification)");
  const q = (api: string, version: string, method: string) => call(send, "Synology", a, "POST", "/webapi/entry.cgi", formHeaders, form({ api, version, method, _sid: sid }));
  try {
    const [system, storage] = await Promise.all([q("SYNO.Core.System", "1", "info"), q("SYNO.Storage.CGI.Storage", "1", "load_info")]);
    const s = obj(obj(system.json).data);
    const st = obj(obj(storage.json).data);
    return {
      model: clean(s.model),
      version: clean(s.firmware_ver),
      temperatureC: num(s.sys_temp),
      uptime: clean(s.up_time),
      volumes: arr(st.volumes).map((v) => {
        const size = obj(v.size);
        return { id: clean(v.id), status: clean(v.status), usedPercent: pct(size.used, size.total), sizeGb: gb(size.total) };
      }),
      disks: arr(st.disks)
        .slice(0, 60)
        .map((d) => ({ id: clean(d.id), name: clean(d.name), model: clean(d.model), status: clean(d.status), smart: clean(d.smart_status), temperatureC: num(d.temp) })),
    };
  } finally {
    await q("SYNO.API.Auth", "6", "logout").catch(() => {});
  }
}

// --- Home Assistant -----------------------------------------------------------------------------

export async function homeassistantStates(a: Base & { token: string; domain?: string; entity?: string; limit: number }, send: RawRequest = sendRequest) {
  // One entity (a monitor reading a sensor): its own endpoint. The id was checked by the argument schema.
  const path = a.entity ? `/api/states/${a.entity}` : "/api/states";
  const { json } = await call(send, "Home Assistant", a, "GET", path, { Authorization: `Bearer ${a.token}` });
  const states = (a.entity ? [obj(json)] : arr(json)).filter((s) => typeof s.entity_id === "string" && (!a.domain || (s.entity_id as string).startsWith(`${a.domain}.`)));
  return {
    total: states.length,
    entities: states.slice(0, a.limit).map((s) => {
      const attrs = obj(s.attributes);
      return { entity: clean(s.entity_id), name: clean(attrs.friendly_name), state: clean(s.state), unit: clean(attrs.unit_of_measurement), changed: clean(s.last_changed) };
    }),
  };
}

// --- Pi-hole v6 ---------------------------------------------------------------------------------

export async function piholeSummary(a: Base & { password: string }, send: RawRequest = sendRequest) {
  const auth = await call(send, "Pi-hole", a, "POST", "/api/auth", { "Content-Type": "application/json" }, JSON.stringify({ password: a.password }));
  const session = obj(obj(auth.json).session);
  const sid = clean(session.sid);
  if (session.valid !== true || !sid) throw new HomelabError("Pi-hole refused the password (Pi-hole v6 is required)");
  const h = { "X-FTL-SID": sid };
  try {
    const [summary, top] = await Promise.all([call(send, "Pi-hole", a, "GET", "/api/stats/summary", h), call(send, "Pi-hole", a, "GET", "/api/stats/top_clients?count=10", h)]);
    const s = obj(summary.json);
    const queries = obj(s.queries);
    return {
      queries: num(queries.total),
      blocked: num(queries.blocked),
      blockedPercent: num(queries.percent_blocked) !== undefined ? Math.round(num(queries.percent_blocked)! * 10) / 10 : undefined,
      activeClients: num(obj(s.clients).active),
      domainsOnBlocklists: num(obj(s.gravity).domains_being_blocked),
      topClients: arr(obj(top.json).clients).map((c) => ({ ip: clean(c.ip), name: clean(c.name) || undefined, queries: num(c.count) })),
    };
  } finally {
    await call(send, "Pi-hole", a, "DELETE", "/api/auth", h).catch(() => {});
  }
}

// --- AdGuard Home -------------------------------------------------------------------------------

export async function adguardStats(a: Base & { user: string; password: string }, send: RawRequest = sendRequest) {
  const h = { Authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}` };
  const [stats, status] = await Promise.all([call(send, "AdGuard Home", a, "GET", "/control/stats", h), call(send, "AdGuard Home", a, "GET", "/control/status", h)]);
  const s = obj(stats.json);
  const st = obj(status.json);
  const top = (v: unknown) =>
    arr(v)
      .flatMap((entry) => Object.entries(entry))
      .slice(0, 10)
      .map(([key, count]) => ({ name: clean(key), count: num(count) }));
  return {
    version: clean(st.version),
    protectionEnabled: st.protection_enabled === true,
    queries: num(s.num_dns_queries),
    blocked: num(s.num_blocked_filtering),
    blockedPercent: pct(s.num_blocked_filtering, s.num_dns_queries),
    avgProcessingMs: num(s.avg_processing_time) !== undefined ? Math.round(num(s.avg_processing_time)! * 1000 * 10) / 10 : undefined,
    topClients: top(s.top_clients),
    topBlockedDomains: top(s.top_blocked_domains),
  };
}
