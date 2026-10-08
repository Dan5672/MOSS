// UniFi Network: signing in (an API key, or a local account's username and password), and the read-only
// firewall view. Requests go to the literal controller IP over HTTPS; consoles ship self-signed
// certificates, so they aren't verified. The password is only ever sent to that address, and the session
// is signed out again after each tool call. Everything the console returns is cleaned and bounded here.
import type { UnifiClient, UnifiClientsResult } from "@moss/tools";
import { sendRequest, type RawRequest } from "./custom-http.js";
import { HomelabError } from "./homelab.js";
import { clean } from "./parsers.js";

export interface UnifiAuth {
  controller: string;
  port: number;
  site: string;
  timeoutMs: number;
  apiKey?: string;
  username?: string;
  password?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : []);
const strs = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.slice(0, max).map((x) => clean(x)).filter((x): x is string => !!x) : []);

export type UnifiRequest = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<unknown>;

/** Exactly one way to sign in. */
export function unifiAuthMode(a: UnifiAuth): "key" | "login" {
  const login = a.username !== undefined || a.password !== undefined;
  if (a.apiKey && login) throw new HomelabError("Give either an API key or a username and password, not both");
  if (a.apiKey) return "key";
  if (a.username && a.password) return "login";
  throw new HomelabError("Sign in with an API key (apiKey), or a local account (username and password)");
}

function cookiesFrom(headers: Record<string, string | string[] | undefined> | undefined): string {
  const raw = headers?.["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(";")[0]!.trim()).filter((c) => /^[A-Za-z0-9_.-]+=/.test(c)).join("; ");
}

const header = (headers: Record<string, string | string[] | undefined> | undefined, name: string) => {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Runs `fn` with a signed-in request function. Paths are the Network application's own (/api/s/<site>/...,
 * /v2/api/site/<site>/...); on a UniFi OS console (UDM, UCG, Cloud Key Gen2+) they are reached under
 * /proxy/network, on a self-hosted Network application directly.
 */
export async function withUnifi<T>(send: RawRequest, a: UnifiAuth, fn: (req: UnifiRequest) => Promise<T>): Promise<T> {
  const mode = unifiAuthMode(a);
  const raw = async (method: "GET" | "POST" | "PUT", path: string, headers: Record<string, string>, body?: unknown) => {
    try {
      return await send({
        target: a.controller,
        port: a.port,
        scheme: "https",
        method,
        path,
        headers: { Accept: "application/json", ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        verifyTls: false,
        timeoutMs: a.timeoutMs,
        maxItems: 1,
      });
    } catch (err) {
      throw new HomelabError(`Could not reach the UniFi console at ${a.controller}:${a.port}: ${(err as Error).message}`);
    }
  };

  let prefix = "/proxy/network";
  let auth: Record<string, string> = {};
  let logout: (() => Promise<unknown>) | null = null;
  if (mode === "key") {
    auth = { "X-API-KEY": a.apiKey! };
  } else {
    const creds = { username: a.username, password: a.password };
    let res = await raw("POST", "/api/auth/login", {}, { ...creds, rememberMe: false });
    if (res.status === 404) {
      // Not a UniFi OS console: a self-hosted UniFi Network application.
      prefix = "";
      res = await raw("POST", "/api/login", {}, { ...creds, remember: false });
    }
    if (res.status === 429) throw new HomelabError("The UniFi console is refusing sign-ins for now (too many attempts); try again later");
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HomelabError(
        "The UniFi console rejected the username or password. Use a local account (UniFi OS: Admins & Users, " +
          "\"Restrict to local access only\"); a Ubiquiti cloud account with two-factor sign-in can't sign in this way",
      );
    }
    if (res.status !== 200) throw new HomelabError(`The UniFi console answered the sign-in with HTTP ${res.status}`);
    const cookie = cookiesFrom(res.headers);
    if (!cookie) throw new HomelabError("The UniFi console accepted the sign-in but sent no session");
    // UniFi OS sends the CSRF token as a header; the classic application as a cookie.
    const csrf = header(res.headers, "x-csrf-token") ?? /(?:^|; )csrf_token=([^;]+)/.exec(cookie)?.[1];
    auth = { Cookie: cookie, ...(csrf ? { "X-CSRF-Token": csrf } : {}) };
    logout = () => raw("POST", prefix ? "/api/auth/logout" : "/api/logout", auth, {});
  }

  const req: UnifiRequest = async (method, path, body) => {
    const res = await raw(method, prefix + path, auth, body);
    if (res.status === 401 || res.status === 403) {
      throw new HomelabError(mode === "key" ? "The UniFi console rejected the API key" : "This UniFi account isn't allowed to do that (it needs an administrator role)");
    }
    if (res.status === 404) throw Object.assign(new HomelabError(`The UniFi console has no ${path.replace(/\/s(ite)?\/[^/]+/, "/…")}`), { notFound: true });
    if (res.truncated) throw new HomelabError("The UniFi console's answer was too large");
    let json: unknown;
    try {
      json = JSON.parse(res.body.toString("utf8") || "null");
    } catch {
      throw new HomelabError(`The UniFi console answered HTTP ${res.status} with something that isn't JSON`);
    }
    if (res.status >= 400) throw new HomelabError(`The UniFi console answered HTTP ${res.status}: ${clean(obj(obj(json).meta).msg) ?? clean(obj(json).message) ?? ""}`.trim());
    const meta = obj(obj(json).meta);
    if (meta.rc && meta.rc !== "ok") throw new HomelabError(`UniFi refused: ${clean(meta.msg) ?? "error"}`);
    return json;
  };

  try {
    return await fn(req);
  } finally {
    await logout?.().catch(() => {});
  }
}

const isNotFound = (err: unknown) => !!(err && typeof err === "object" && (err as { notFound?: boolean }).notFound);
/** The `data` array of a classic /api/s/... answer. */
export const dataOf = (json: unknown) => arr(obj(json).data);

// --- Clients, signed in with a username and password ----------------------------------------------

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The connected clients, from the classic API (the official one needs an API key). */
export async function unifiClientsByLogin(a: UnifiAuth, send: RawRequest = sendRequest): Promise<UnifiClientsResult> {
  return withUnifi(send, a, async (req) => {
    const rows = dataOf(await req("GET", `/api/s/${a.site}/stat/sta`));
    const clients: UnifiClient[] = rows.slice(0, 2000).map((c) => {
      const ip = clean(c.ip);
      const mac = clean(c.mac)?.toLowerCase();
      return {
        ip: ip && IPV4.test(ip) ? ip : undefined,
        mac: mac && MAC.test(mac) ? mac : undefined,
        name: clean(c.name) ?? clean(c.hostname),
        type: c.is_wired === true ? "wired" : c.is_wired === false ? "wireless" : undefined,
        connectedAt: typeof c.assoc_time === "number" ? new Date(c.assoc_time * 1000).toISOString() : undefined,
        uplinkDevice: clean(c.uplink_name) ?? clean(c.ap_mac) ?? clean(c.sw_mac),
      };
    });
    return {
      site: a.site,
      clients,
      hosts: clients.flatMap((c) => (c.ip ? [{ ip: c.ip, mac: c.mac, hostnames: c.name ? [c.name] : [], status: "up" as const }] : [])),
    };
  });
}

// --- Firewall (read-only) -------------------------------------------------------------------------

/** One side of a zone-based policy, in words. */
function policyEnd(end: Json, zones: Map<string, string>, networks: Map<string, string>) {
  const target = clean(end.matching_target)?.toUpperCase() ?? "ANY";
  const what =
    target === "NETWORK"
      ? strs(end.network_ids).map((id) => networks.get(id) ?? id)
      : target === "IP"
        ? strs(end.ips)
        : target === "REGION"
          ? strs(end.regions)
          : target === "WEB"
            ? strs(end.web_domains)
            : [];
  const ports = clean(end.port) ?? (end.port_matching_type === "LIST" ? strs(end.ports).join(",") : undefined);
  return {
    zone: zones.get(clean(end.zone_id) ?? "") ?? clean(end.zone_id),
    match: target,
    ...(what.length ? { values: what } : {}),
    ...(ports ? { ports } : {}),
  };
}

/** The gateway's networks, firewall rules or zone-based policies, and port forwards. */
export async function unifiFirewall(a: UnifiAuth & { includeBuiltIn: boolean }, send: RawRequest = sendRequest) {
  return withUnifi(send, a, async (req) => {
    const site = a.site;
    const networkRows = dataOf(await req("GET", `/api/s/${site}/rest/networkconf`));
    const networks = new Map(networkRows.map((n) => [clean(n._id) ?? "", clean(n.name) ?? "?"]));
    const groupRows = dataOf(await req("GET", `/api/s/${site}/rest/firewallgroup`));
    const groups = new Map(groupRows.map((g) => [clean(g._id) ?? "", { name: clean(g.name) ?? "?", members: strs(g.group_members, 30) }]));
    const named = (ids: unknown) => strs(ids).map((id) => groups.get(id)?.name ?? id);

    // Zone-based firewall (UniFi Network 9.x): policies between zones. Older versions don't have it.
    let zonePolicies: Json[] | null = null;
    let zones = new Map<string, string>();
    try {
      const zoneRows = arr(await req("GET", `/v2/api/site/${site}/firewall/zone`));
      zones = new Map(zoneRows.map((z) => [clean(z._id) ?? "", clean(z.name) ?? "?"]));
      zonePolicies = arr(await req("GET", `/v2/api/site/${site}/firewall-policies`));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const rules = dataOf(await req("GET", `/api/s/${site}/rest/firewallrule`).catch((err) => (isNotFound(err) ? { data: [] } : Promise.reject(err))));
    const forwards = dataOf(await req("GET", `/api/s/${site}/rest/portforward`).catch((err) => (isNotFound(err) ? { data: [] } : Promise.reject(err))));

    const policies = (zonePolicies ?? [])
      .filter((p) => a.includeBuiltIn || p.predefined !== true)
      .sort((x, y) => Number(x.index ?? 0) - Number(y.index ?? 0))
      .slice(0, 200)
      .map((p) => ({
        name: clean(p.name),
        enabled: p.enabled !== false,
        action: clean(p.action)?.toLowerCase(),
        protocol: clean(p.protocol) ?? "all",
        from: policyEnd(obj(p.source), zones, networks),
        to: policyEnd(obj(p.destination), zones, networks),
        ...(p.predefined === true ? { builtIn: true } : {}),
        ...(p.logging === true ? { logged: true } : {}),
      }));

    return {
      site,
      firewall: zonePolicies ? "zone-based" : "rules",
      networks: networkRows.slice(0, 100).map((n) => ({
        name: clean(n.name),
        purpose: clean(n.purpose),
        subnet: clean(n.ip_subnet),
        vlan: typeof n.vlan === "number" || typeof n.vlan === "string" ? Number(n.vlan) || undefined : undefined,
        enabled: n.enabled !== false,
      })),
      ...(zonePolicies ? { zones: [...zones.values()], policies, builtInHidden: a.includeBuiltIn ? 0 : zonePolicies.filter((p) => p.predefined === true).length } : {}),
      rules: rules
        .sort((x, y) => String(x.ruleset).localeCompare(String(y.ruleset)) || Number(x.rule_index ?? 0) - Number(y.rule_index ?? 0))
        .slice(0, 200)
        .map((r) => ({
          name: clean(r.name),
          enabled: r.enabled !== false,
          ruleset: clean(r.ruleset),
          index: typeof r.rule_index === "number" ? r.rule_index : undefined,
          action: clean(r.action),
          protocol: clean(r.protocol) ?? "all",
          from: {
            ...(clean(r.src_networkconf_id) ? { network: networks.get(clean(r.src_networkconf_id)!) ?? clean(r.src_networkconf_id) } : {}),
            ...(clean(r.src_address) ? { address: clean(r.src_address) } : {}),
            ...(named(r.src_firewallgroup_ids).length ? { groups: named(r.src_firewallgroup_ids) } : {}),
          },
          to: {
            ...(clean(r.dst_networkconf_id) ? { network: networks.get(clean(r.dst_networkconf_id)!) ?? clean(r.dst_networkconf_id) } : {}),
            ...(clean(r.dst_address) ? { address: clean(r.dst_address) } : {}),
            ...(clean(r.dst_port) ? { ports: clean(r.dst_port) } : {}),
            ...(named(r.dst_firewallgroup_ids).length ? { groups: named(r.dst_firewallgroup_ids) } : {}),
          },
        })),
      groups: [...groups.values()].slice(0, 100),
      portForwards: forwards.slice(0, 100).map((f) => ({
        name: clean(f.name),
        enabled: f.enabled !== false,
        protocol: clean(f.proto),
        port: clean(f.dst_port),
        to: `${clean(f.fwd) ?? "?"}:${clean(f.fwd_port) ?? clean(f.dst_port) ?? "?"}`,
        from: clean(f.src) ?? "any",
      })),
    };
  });
}
