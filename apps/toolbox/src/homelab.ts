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

const PVE_TOKEN = /^[^\s=]+@[^\s=]+![^\s=]+=[^\s]+$/;
export const pveAuth = (token: string) => {
  if (!PVE_TOKEN.test(token)) throw new HomelabError("The Proxmox token should look like USER@REALM!TOKENID=SECRET");
  return { Authorization: `PVEAPIToken=${token}` };
};

/** Runs fn over items, a few at a time (Proxmox answers per guest; don't flood it). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const pveType = (kind: unknown) => (kind === "qemu" || kind === "vm" ? "qemu" : "lxc");

/** A guest's config, or {} if it can't be read (a guest being migrated, a token without access). */
async function guestConfig(send: RawRequest, a: Base & { token: string }, node: string, type: "qemu" | "lxc", vmid: number) {
  try {
    return obj(obj((await call(send, "Proxmox", a, "GET", `/api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmid}/config`, pveAuth(a.token))).json).data);
  } catch {
    return {};
  }
}

export async function proxmoxStatus(a: Base & { token: string; bootFlags?: boolean }, send: RawRequest = sendRequest) {
  const { json } = await call(send, "Proxmox", a, "GET", "/api2/json/cluster/resources", pveAuth(a.token));
  const items = arr(obj(json).data);
  const guests = items.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.template !== 1).slice(0, 300);
  // Whether each guest starts at boot: a stopped guest that should be running is a problem; one that shouldn't isn't.
  const onboot = a.bootFlags
    ? await mapLimit(guests.slice(0, 150), 5, async (r) => (await guestConfig(send, a, String(r.node), pveType(r.type), num(r.vmid) ?? 0)).onboot === 1)
    : [];
  return {
    nodes: items
      .filter((r) => r.type === "node")
      .map((r) => ({ node: clean(r.node), status: clean(r.status), cpuPercent: pct(r.cpu, 1), memoryPercent: pct(r.mem, r.maxmem), diskPercent: pct(r.disk, r.maxdisk), uptimeDays: num(r.uptime) ? Math.round((num(r.uptime)! / 86400) * 10) / 10 : undefined })),
    guests: guests.map((r, i) => ({
      id: num(r.vmid),
      name: clean(r.name),
      kind: r.type === "qemu" ? "vm" : "container",
      node: clean(r.node),
      status: clean(r.status),
      cpuPercent: pct(r.cpu, 1),
      memoryPercent: pct(r.mem, r.maxmem),
      ...(a.bootFlags && i < onboot.length ? { onboot: onboot[i] } : {}),
    })),
    storage: items
      .filter((r) => r.type === "storage")
      .slice(0, 100)
      .map((r) => ({ storage: clean(r.storage), node: clean(r.node), status: clean(r.status), usedPercent: pct(r.disk, r.maxdisk), sizeGb: gb(r.maxdisk) })),
  };
}

const NET_MAC = /(?:^|,)(?:[a-z0-9]+=)?((?:[0-9a-f]{2}:){5}[0-9a-f]{2})(?:,|$)|hwaddr=((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/i;
const IPV4_ONLY = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The MACs in a guest's net0..netN config lines ("virtio=BC:24:11:..,bridge=vmbr0" or "...,hwaddr=BC:24:..."). */
export function guestMacs(config: Record<string, unknown>): string[] {
  return Object.entries(config)
    .filter(([k]) => /^net\d+$/.test(k))
    .flatMap(([, v]) => {
      const m = NET_MAC.exec(String(v));
      const mac = m?.[1] ?? m?.[2];
      return mac ? [mac.toLowerCase()] : [];
    });
}

/** Static addresses in an LXC's net config ("ip=192.168.1.50/24"). */
function staticIps(config: Record<string, unknown>): string[] {
  return Object.entries(config)
    .filter(([k]) => /^net\d+$/.test(k))
    .flatMap(([, v]) => {
      const ip = /(?:^|,)ip=([\d.]+)\//.exec(String(v))?.[1];
      return ip && IPV4_ONLY.test(ip) ? [ip] : [];
    });
}

/**
 * Proxmox's nodes and guests for the inventory: each guest's MACs (from its config), and its addresses where
 * Proxmox knows them (a container's interfaces, or a VM's QEMU guest agent).
 */
export async function proxmoxInventory(a: Base & { token: string }, send: RawRequest = sendRequest) {
  const h = pveAuth(a.token);
  const [resources, status] = await Promise.all([call(send, "Proxmox", a, "GET", "/api2/json/cluster/resources", h), call(send, "Proxmox", a, "GET", "/api2/json/cluster/status", h)]);
  const items = arr(obj(resources.json).data);
  const nodeIps = new Map(arr(obj(status.json).data).filter((n) => n.type === "node").map((n) => [clean(n.name), clean(n.ip)]));
  const guests = items.filter((r) => (r.type === "qemu" || r.type === "lxc") && r.template !== 1).slice(0, 300);
  const details = await mapLimit(guests, 5, async (r) => {
    const node = String(r.node);
    const type = pveType(r.type);
    const vmid = num(r.vmid) ?? 0;
    const cfg = await guestConfig(send, a, node, type, vmid);
    let ips = staticIps(cfg);
    if (r.status === "running") {
      try {
        if (type === "lxc") {
          const { json: j } = await call(send, "Proxmox", a, "GET", `/api2/json/nodes/${encodeURIComponent(node)}/lxc/${vmid}/interfaces`, h);
          ips = [...ips, ...arr(obj(j).data).flatMap((i) => [clean(i.inet)?.split("/")[0]].filter((x): x is string => !!x && IPV4_ONLY.test(x) && !x.startsWith("127.")))];
        } else if (/^(1|enabled=1)/.test(String(cfg.agent ?? ""))) {
          const { json: j } = await call(send, "Proxmox", a, "GET", `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`, h);
          ips = [
            ...ips,
            ...arr(obj(obj(j).data).result).flatMap((i) =>
              arr(i["ip-addresses"]).flatMap((x) => (x["ip-address-type"] === "ipv4" && IPV4_ONLY.test(String(x["ip-address"])) && !String(x["ip-address"]).startsWith("127.") ? [String(x["ip-address"])] : [])),
            ),
          ];
        }
      } catch {
        // No guest agent answering, or no permission: the MACs are still enough to match.
      }
    }
    return { macs: guestMacs(cfg), ips: [...new Set(ips)], onboot: cfg.onboot === 1, ostype: clean(cfg.ostype) };
  });
  return {
    nodes: items.filter((r) => r.type === "node").map((r) => ({ node: clean(r.node), status: clean(r.status), ip: nodeIps.get(clean(r.node)) })),
    guests: guests.map((r, i) => ({ id: num(r.vmid), name: clean(r.name), kind: r.type === "qemu" ? "vm" : "container", node: clean(r.node), status: clean(r.status), ...details[i] })),
  };
}

// --- Proxmox Backup Server ---------------------------------------------------------------------

/** PBS tokens are USER@REALM!TOKENID:SECRET (some people copy them with = like Proxmox VE's; both work). */
const pbsAuth = (token: string) => {
  const t = token.replace(/^([^\s=:]+@[^\s=:]+![^\s=:]+)=/, "$1:");
  if (!/^[^\s=:]+@[^\s=:]+![^\s=:]+:[^\s]+$/.test(t)) throw new HomelabError("The Proxmox Backup Server token should look like USER@REALM!TOKENID:SECRET");
  return { Authorization: `PBSAPIToken=${t}` };
};

/** Each datastore's use, and the last backup of each guest (backup group) in it. */
export async function pbsStatus(a: Base & { token: string }, send: RawRequest = sendRequest) {
  const h = pbsAuth(a.token);
  const { json } = await call(send, "Proxmox Backup Server", a, "GET", "/api2/json/status/datastore-usage", h);
  const stores = arr(obj(json).data).slice(0, 20);
  const groups = await mapLimit(stores, 3, async (s) => {
    const store = String(s.store);
    const { json: g } = await call(send, "Proxmox Backup Server", a, "GET", `/api2/json/admin/datastore/${encodeURIComponent(store)}/groups`, h);
    return arr(obj(g).data)
      .slice(0, 300)
      .map((x) => ({
        store,
        type: clean(x["backup-type"]),
        id: clean(x["backup-id"]),
        comment: clean(x.comment) || undefined,
        lastBackup: num(x["last-backup"]) ? new Date(num(x["last-backup"])! * 1000).toISOString() : undefined,
        count: num(x["backup-count"]),
      }));
  });
  return {
    datastores: stores.map((s) => ({ store: clean(s.store), usedPercent: pct(s.used, s.total), totalGb: gb(s.total) })),
    groups: groups.flat(),
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

/** Signs in to Pi-hole v6, runs fn with the session header, and always signs out (sessions are limited). */
export async function piholeSession<T>(send: RawRequest, a: Base & { password: string }, fn: (h: Record<string, string>) => Promise<T>) {
  const auth = await call(send, "Pi-hole", a, "POST", "/api/auth", { "Content-Type": "application/json" }, JSON.stringify({ password: a.password }));
  const session = obj(obj(auth.json).session);
  const sid = clean(session.sid);
  if (session.valid !== true || !sid) throw new HomelabError("Pi-hole refused the password (Pi-hole v6 is required)");
  const h = { "X-FTL-SID": sid };
  try {
    return await fn(h);
  } finally {
    await call(send, "Pi-hole", a, "DELETE", "/api/auth", h).catch(() => {});
  }
}

export async function piholeSummary(a: Base & { password: string }, send: RawRequest = sendRequest) {
  return piholeSession(send, a, async (h) => {
    const [summary, top, blocking] = await Promise.all([
      call(send, "Pi-hole", a, "GET", "/api/stats/summary", h),
      call(send, "Pi-hole", a, "GET", "/api/stats/top_clients?count=10", h),
      call(send, "Pi-hole", a, "GET", "/api/dns/blocking", h),
    ]);
    const s = obj(summary.json);
    const queries = obj(s.queries);
    return {
      /** enabled, disabled (someone paused it), failed or unknown. */
      blocking: clean(obj(blocking.json).blocking) ?? "unknown",
      queries: num(queries.total),
      blocked: num(queries.blocked),
      blockedPercent: num(queries.percent_blocked) !== undefined ? Math.round(num(queries.percent_blocked)! * 10) / 10 : undefined,
      activeClients: num(obj(s.clients).active),
      domainsOnBlocklists: num(obj(s.gravity).domains_being_blocked),
      topClients: arr(obj(top.json).clients).map((c) => ({ ip: clean(c.ip), name: clean(c.name) || undefined, queries: num(c.count) })),
    };
  });
}

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** The devices Pi-hole has seen on the network: MAC, maker, and each address with the name it resolved to. */
export async function piholeClients(a: Base & { password: string; limit: number }, send: RawRequest = sendRequest) {
  return piholeSession(send, a, async (h) => {
    const { json } = await call(send, "Pi-hole", a, "GET", `/api/network/devices?max_devices=${a.limit}&max_addresses=4`, h);
    const devices = arr(obj(json).devices).map((d) => {
      const hw = (clean(d.hwaddr) ?? "").toLowerCase();
      const addrs = arr(d.ips).map((x) => ({ ip: clean(x.ip), name: clean(x.name) || undefined })).filter((x) => x.ip);
      return {
        mac: MAC.test(hw) ? hw : undefined,
        vendor: clean(d.macVendor) || undefined,
        name: addrs.find((x) => x.name)?.name,
        ips: addrs.map((x) => x.ip!),
        queries: num(d.numQueries),
        lastQuery: num(d.lastQuery) ? new Date(num(d.lastQuery)! * 1000).toISOString() : undefined,
      };
    });
    return { total: devices.length, devices: devices.slice(0, a.limit) };
  });
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

/** AdGuard Home's clients: the ones set up by hand (with their ids: addresses, MACs) and the ones it found. */
export async function adguardClients(a: Base & { user: string; password: string; limit: number }, send: RawRequest = sendRequest) {
  const h = { Authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}` };
  const { json } = await call(send, "AdGuard Home", a, "GET", "/control/clients", h);
  const j = obj(json);
  const configured = arr(j.clients).map((c) => {
    const ids = (Array.isArray(c.ids) ? c.ids : []).map((x) => String(x).trim().toLowerCase());
    return {
      name: clean(c.name) || undefined,
      macs: ids.filter((x) => MAC.test(x.replace(/-/g, ":"))).map((x) => x.replace(/-/g, ":")),
      ips: ids.filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)),
      configured: true,
    };
  });
  const found = arr(j.auto_clients).map((c) => ({ name: clean(c.name) || undefined, macs: [] as string[], ips: [clean(c.ip)].filter((x): x is string => !!x), source: clean(c.source), configured: false }));
  const clients = [...configured, ...found];
  return { total: clients.length, clients: clients.slice(0, a.limit) };
}
