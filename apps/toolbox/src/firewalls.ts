// OPNsense (its own API, an API key and secret) and pfSense (the pfSense REST API package, an API key): DHCP
// leases, gateways and updates, read the same way for both. Blocking a device only ever adds or removes an address in
// one alias ("moss_blocked") that the owner's own block rule uses; MOSS never edits firewall rules.
import { sendRequest, type RawRequest } from "./custom-http.js";
import { arr, call, HomelabError, num, obj, type Base } from "./homelab.js";
import { clean } from "./parsers.js";

export interface FirewallStatus {
  product: "opnsense" | "pfsense";
  version?: string;
  leases: { ip: string; mac?: string; hostname?: string }[];
  gateways: { name: string; address?: string; online: boolean; status: string; lossPercent?: number; delayMs?: number }[];
  update?: { available: boolean; message?: string };
}

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const mac = (v: unknown) => {
  const m = String(v ?? "").toLowerCase();
  return MAC.test(m) ? m : undefined;
};
const pctNum = (v: unknown) => num(String(v ?? "").replace(/[^\d.]/g, ""));

// --- OPNsense -----------------------------------------------------------------------------------

type OpnArgs = Base & { user: string; password: string };
const opnAuth = (a: OpnArgs) => ({ Authorization: `Basic ${Buffer.from(`${a.user}:${a.password}`).toString("base64")}` });

export async function opnsenseStatus(a: OpnArgs, send: RawRequest = sendRequest): Promise<FirewallStatus> {
  const h = opnAuth(a);
  const get = async (path: string) => (await call(send, "OPNsense", a, "GET", path, h)).json;
  const maybe = async (path: string) => {
    try {
      return await get(path);
    } catch (err) {
      if (/rejected the credentials/.test((err as Error).message)) throw err;
      return null;
    }
  };
  // Leases from whichever DHCP server is in use: Kea, dnsmasq (24.7+) or ISC.
  const [kea, dnsmasq, isc, gw, fw] = await Promise.all([
    maybe("/api/kea/leases4/search"),
    maybe("/api/dnsmasq/leases/search"),
    maybe("/api/dhcpv4/leases/searchLease"),
    get("/api/routes/gateway/status"),
    maybe("/api/core/firmware/status"),
  ]);
  const rows = [...arr(obj(kea).rows), ...arr(obj(dnsmasq).rows), ...arr(obj(isc).rows)];
  const seen = new Set<string>();
  const leases = rows.flatMap((r) => {
    const ip = clean(r.address);
    if (!ip || seen.has(ip)) return [];
    seen.add(ip);
    return [{ ip, mac: mac(r.hwaddr ?? r.mac), hostname: clean(r.hostname) || undefined }];
  });
  const gateways = arr(obj(gw).items).map((g) => {
    const translated = clean(g.status_translated) ?? clean(g.status) ?? "unknown";
    return {
      name: clean(g.name) ?? "?",
      address: clean(g.address),
      online: !/offline|down/i.test(translated) && g.status !== "down",
      status: translated,
      lossPercent: pctNum(g.loss),
      delayMs: pctNum(g.delay),
    };
  });
  const f = obj(fw);
  const product = obj(f.product);
  return {
    product: "opnsense",
    version: clean(product.product_version) ?? clean(f.product_version),
    leases: leases.slice(0, 1000),
    gateways,
    ...(fw ? { update: { available: f.status === "update" || f.status === "upgrade", message: clean(f.status_msg) } } : {}),
  };
}

/** Adds or removes an address in the alias (which must exist; the block rule that uses it is the owner's). */
export async function opnsenseBlock(a: OpnArgs & { alias: string; address: string; action: "add" | "remove" }, send: RawRequest = sendRequest) {
  const h = { ...opnAuth(a), "Content-Type": "application/json" };
  const path = a.action === "add" ? `/api/firewall/alias_util/add/${encodeURIComponent(a.alias)}` : `/api/firewall/alias_util/delete/${encodeURIComponent(a.alias)}`;
  const { json } = await call(send, "OPNsense", a, "POST", path, h, JSON.stringify({ address: a.address }));
  const status = clean(obj(json).status);
  if (status && status !== "done") throw new HomelabError(`OPNsense didn't update the ${a.alias} alias (${status}). Create a Host(s) alias called ${a.alias} and a block rule that uses it.`);
  const { json: list } = await call(send, "OPNsense", a, "GET", `/api/firewall/alias_util/list/${encodeURIComponent(a.alias)}`, opnAuth(a));
  const listed = arr(obj(list).rows).some((r) => clean(r.ip) === a.address);
  return { alias: a.alias, address: a.address, action: a.action, inAlias: listed };
}

// --- pfSense (REST API package v2) --------------------------------------------------------------

type PfArgs = Base & { apiKey: string };
const pfAuth = (a: PfArgs) => ({ "X-API-Key": a.apiKey });

export async function pfsenseStatus(a: PfArgs, send: RawRequest = sendRequest): Promise<FirewallStatus> {
  const get = async (path: string) => obj((await call(send, "pfSense", a, "GET", path, pfAuth(a))).json).data;
  let leasesData: unknown;
  try {
    leasesData = await get("/api/v2/status/dhcp_server/leases");
  } catch (err) {
    if (/HTTP 404/.test((err as Error).message)) throw new HomelabError("pfSense has no REST API: install the pfSense REST API package (pfrest) first");
    throw err;
  }
  const [gw, version] = await Promise.all([get("/api/v2/status/gateways"), get("/api/v2/system/version").catch(() => ({}))]);
  return {
    product: "pfsense",
    version: clean(obj(version).version),
    leases: arr(leasesData)
      .flatMap((l) => {
        const ip = clean(l.ip);
        return ip ? [{ ip, mac: mac(l.mac), hostname: clean(l.hostname) || undefined }] : [];
      })
      .slice(0, 1000),
    gateways: arr(gw).map((g) => {
      const status = clean(g.status) ?? "unknown";
      return { name: clean(g.name) ?? "?", address: clean(g.monitorip) ?? clean(g.srcip), online: /online|none/i.test(status), status, lossPercent: pctNum(g.loss), delayMs: pctNum(g.delay) };
    }),
  };
}

export async function pfsenseBlock(a: PfArgs & { alias: string; address: string; action: "add" | "remove" }, send: RawRequest = sendRequest) {
  const h = { ...pfAuth(a), "Content-Type": "application/json" };
  const { json } = await call(send, "pfSense", a, "GET", `/api/v2/firewall/aliases?name=${encodeURIComponent(a.alias)}`, pfAuth(a));
  const alias = arr(obj(json).data)[0];
  if (!alias) throw new HomelabError(`pfSense has no alias called ${a.alias}. Create a Host(s) alias with that name and a block rule that uses it.`);
  const addresses = (Array.isArray(alias.address) ? alias.address : []).map(String);
  const next = a.action === "add" ? [...new Set([...addresses, a.address])] : addresses.filter((x) => x !== a.address);
  if (next.length !== addresses.length || a.action === "remove") {
    await call(send, "pfSense", a, "PATCH", "/api/v2/firewall/alias", h, JSON.stringify({ id: alias.id, address: next }));
    await call(send, "pfSense", a, "POST", "/api/v2/firewall/apply", h, "{}");
  }
  return { alias: a.alias, address: a.address, action: a.action, inAlias: next.includes(a.address) };
}
