// Cisco Meraki, read-only through the Dashboard API (api.meraki.com) with an API key for a read-only organisation
// admin: every organisation the key can see (up to 5), their devices and whether they're online, appliance uplinks
// with loss and latency, and site-to-site VPN peers; and separately, the clients each network has seen.
import { clean } from "./parsers.js";

export class MerakiError extends Error {}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const API = "https://api.meraki.com/api/v1";

async function get(f: Fetch, key: string, path: string, timeoutMs: number, optional = false): Promise<unknown> {
  const res = await f(`${API}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401) throw new MerakiError("Meraki rejected the API key");
  if (res.status === 429) throw new MerakiError("Meraki is limiting requests: try again shortly");
  if (res.status !== 200) {
    if (optional) return null;
    throw new MerakiError(res.status === 403 || res.status === 404 ? `The API key can't read ${path.split("?")[0]}` : `Meraki answered HTTP ${res.status}`);
  }
  return res.json();
}

const orgsOf = async (f: Fetch, key: string, timeoutMs: number) => arr(await get(f, key, "/organizations", timeoutMs)).slice(0, 5);

export async function merakiDevices(a: { apiKey: string; timeoutMs: number }, f: Fetch = fetch as unknown as Fetch) {
  const orgs = await orgsOf(f, a.apiKey, a.timeoutMs);
  const devices = [];
  const uplinks = [];
  const vpnPeers = [];
  for (const o of orgs) {
    const id = encodeURIComponent(String(o.id));
    const org = clean(o.name) ?? String(o.id);
    for (const d of arr(await get(f, a.apiKey, `/organizations/${id}/devices/statuses?perPage=1000`, a.timeoutMs)).slice(0, 1000)) {
      devices.push({
        serial: clean(d.serial) ?? "",
        name: clean(d.name) || clean(d.serial) || "?",
        model: clean(d.model),
        type: clean(d.productType),
        status: clean(d.status) ?? "unknown",
        mac: clean(d.mac)?.toLowerCase(),
        lanIp: clean(d.lanIp),
        publicIp: clean(d.publicIp),
        network: clean(d.networkId),
        org,
      });
    }
    // Loss and latency over the last 5 minutes, by appliance and uplink.
    const quality = new Map<string, { loss?: number; latency?: number }>();
    for (const q of arr(await get(f, a.apiKey, `/organizations/${id}/devices/uplinksLossAndLatency?timespan=300`, a.timeoutMs, true))) {
      const series = arr(q.timeSeries).filter((t) => num(t.lossPercent) !== undefined || num(t.latencyMs) !== undefined);
      const last = series.at(-1);
      if (last) quality.set(`${q.serial}:${q.uplink}`, { loss: num(last.lossPercent), latency: num(last.latencyMs) });
    }
    for (const s of arr(await get(f, a.apiKey, `/organizations/${id}/appliance/uplink/statuses?perPage=1000`, a.timeoutMs, true))) {
      for (const u of arr(s.uplinks)) {
        const q = quality.get(`${s.serial}:${u.interface}`) ?? {};
        uplinks.push({ serial: clean(s.serial) ?? "", interface: clean(u.interface) ?? "?", status: clean(u.status) ?? "unknown", ip: clean(u.ip), publicIp: clean(u.publicIp), lossPercent: q.loss, latencyMs: q.latency });
      }
    }
    for (const v of arr(await get(f, a.apiKey, `/organizations/${id}/appliance/vpn/statuses?perPage=300`, a.timeoutMs, true))) {
      const network = clean(v.networkName) ?? String(v.networkId);
      for (const p of arr(v.merakiVpnPeers)) vpnPeers.push({ network, peer: clean(p.networkName) ?? String(p.networkId), reachable: p.reachability === "reachable" });
      for (const p of arr(v.thirdPartyVpnPeers)) vpnPeers.push({ network, peer: clean(p.name) ?? clean(p.publicIp) ?? "?", reachable: p.reachability === "reachable" });
    }
  }
  return { organizations: orgs.map((o) => clean(o.name) ?? String(o.id)), devices, uplinks, vpnPeers };
}

/** Clients each network has seen in the last day (up to 10 networks), for naming devices in the inventory. */
export async function merakiNetwork(a: { apiKey: string; timeoutMs: number }, f: Fetch = fetch as unknown as Fetch) {
  const clients = [];
  for (const o of await orgsOf(f, a.apiKey, a.timeoutMs)) {
    const networks = arr(await get(f, a.apiKey, `/organizations/${encodeURIComponent(String(o.id))}/networks?perPage=100`, a.timeoutMs)).slice(0, 10);
    for (const n of networks) {
      for (const c of arr(await get(f, a.apiKey, `/networks/${encodeURIComponent(String(n.id))}/clients?timespan=86400&perPage=1000`, a.timeoutMs, true)).slice(0, 1000)) {
        clients.push({ id: clean(c.id), mac: clean(c.mac)?.toLowerCase(), ip: clean(c.ip), name: clean(c.description) ?? clean(c.dhcpHostname), vendor: clean(c.manufacturer), os: clean(c.os), network: clean(n.name) });
      }
    }
  }
  return { clients: clients.slice(0, 5000) };
}
