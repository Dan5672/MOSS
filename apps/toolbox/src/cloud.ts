// Cloud services MOSS reads with the owner's token: Tailscale (the tailnet's devices) and Cloudflare (DNS records and
// tunnels, and changing one record through a change). The toolbox calls each service's own fixed address; nothing
// else can be reached through these tools.
import { arr, obj } from "./homelab.js";
import { clean } from "./parsers.js";

export class CloudError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// --- Tailscale ------------------------------------------------------------------------------------

export async function tailscaleDevices(a: { apiKey: string; tailnet: string; timeoutMs: number }, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const res = await fetchImpl(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(a.tailnet)}/devices?fields=all`, {
    headers: { Authorization: `Bearer ${a.apiKey}` },
    signal: AbortSignal.timeout(a.timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new CloudError("Tailscale rejected the API key (it may have expired: keys last up to 90 days)");
  if (res.status !== 200) throw new CloudError(`Tailscale answered HTTP ${res.status}`);
  const devices = arr(obj(await res.json()).devices).slice(0, 500);
  return {
    devices: devices.map((d) => {
      const endpoints = (Array.isArray(obj(d.clientConnectivity).endpoints) ? (obj(d.clientConnectivity).endpoints as unknown[]) : []).map(String);
      return {
        id: clean(d.nodeId) ?? clean(d.id) ?? "",
        name: clean(d.hostname) ?? clean(d.name)?.split(".")[0] ?? "",
        dnsName: clean(d.name),
        os: clean(d.os),
        addresses: (Array.isArray(d.addresses) ? d.addresses : []).map(String),
        /** The device's own addresses on its local network, as Tailscale sees them. */
        lanAddresses: [...new Set(endpoints.map((e) => e.replace(/:\d+$/, "")).filter((ip) => PRIVATE_V4.test(ip)))],
        user: clean(d.user),
        tags: (Array.isArray(d.tags) ? d.tags : []).map(String),
        online: d.connectedToControl === true,
        lastSeen: clean(d.lastSeen),
        keyExpiryDisabled: d.keyExpiryDisabled === true,
        expires: clean(d.expires),
        updateAvailable: d.updateAvailable === true,
        clientVersion: clean(d.clientVersion),
        authorized: d.authorized !== false,
      };
    }),
  };
}

// --- MOSS's own releases --------------------------------------------------------------------------

/** The release tags of MOSS's public repository (only when someone checks for updates). */
export async function mossReleases(a: { timeoutMs: number }, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const res = await fetchImpl("https://api.github.com/repos/Dan5672/MOSS/tags?per_page=100", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "MOSS" },
    signal: AbortSignal.timeout(a.timeoutMs),
  });
  if (res.status === 403 || res.status === 429) throw new CloudError("GitHub is limiting requests from this address; try again in an hour");
  if (res.status !== 200) throw new CloudError(`GitHub answered HTTP ${res.status}`);
  const body = await res.json();
  return { tags: (Array.isArray(body) ? body : []).map((t) => clean(obj(t).name)).filter((n): n is string => !!n).slice(0, 100) };
}

// --- Cloudflare -----------------------------------------------------------------------------------

async function cf(fetchImpl: Fetch, token: string, path: string, timeoutMs: number, init: { method?: string; body?: string } = {}) {
  const res = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(init.body ? { body: init.body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = obj(await res.json().catch(() => ({})));
  if (res.status === 401 || res.status === 403) throw new CloudError("Cloudflare rejected the API token (check its permissions)");
  if (body.success !== true) throw new CloudError(`Cloudflare: ${arr(body.errors).map((e) => clean(e.message)).join("; ") || `HTTP ${res.status}`}`);
  return body.result;
}

export async function cloudflareDns(a: { apiToken: string; timeoutMs: number }, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const zones = arr(await cf(fetchImpl, a.apiToken, "/zones?per_page=50", a.timeoutMs));
  const out = [];
  for (const z of zones.slice(0, 20)) {
    const records = arr(await cf(fetchImpl, a.apiToken, `/zones/${z.id}/dns_records?per_page=500`, a.timeoutMs));
    out.push({
      id: clean(z.id),
      name: clean(z.name),
      accountId: clean(obj(z.account).id),
      records: records.slice(0, 500).map((r) => ({ id: clean(r.id), type: clean(r.type), name: clean(r.name), content: clean(r.content), proxied: r.proxied === true, ttl: typeof r.ttl === "number" ? r.ttl : undefined })),
    });
  }
  return { zones: out };
}

export async function cloudflareTunnels(a: { apiToken: string; timeoutMs: number }, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const zones = arr(await cf(fetchImpl, a.apiToken, "/zones?per_page=50", a.timeoutMs));
  const accounts = [...new Set(zones.map((z) => clean(obj(z.account).id)).filter((x): x is string => !!x))];
  const tunnels = [];
  for (const acc of accounts.slice(0, 5)) {
    for (const t of arr(await cf(fetchImpl, a.apiToken, `/accounts/${acc}/cfd_tunnel?is_deleted=false&per_page=100`, a.timeoutMs)).slice(0, 100)) {
      let hostnames: string[] = [];
      try {
        const config = obj(obj(await cf(fetchImpl, a.apiToken, `/accounts/${acc}/cfd_tunnel/${t.id}/configurations`, a.timeoutMs)).config);
        hostnames = arr(config.ingress).flatMap((i) => (clean(i.hostname) ? [clean(i.hostname)!] : []));
      } catch {
        // Tunnels managed in a local config file have no configuration here.
      }
      tunnels.push({ id: clean(t.id), name: clean(t.name), status: clean(t.status) ?? "unknown", connections: arr(t.connections).length, hostnames });
    }
  }
  return { tunnels };
}

/** Creates, updates or deletes one DNS record (a change-gated write). */
export async function cloudflareDnsRecord(
  a: { apiToken: string; zone: string; action: "upsert" | "delete"; type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; content?: string; proxied: boolean; timeoutMs: number },
  fetchImpl: Fetch = fetch as unknown as Fetch,
) {
  const zones = arr(await cf(fetchImpl, a.apiToken, `/zones?name=${encodeURIComponent(a.zone)}`, a.timeoutMs));
  const zone = zones[0];
  if (!zone) throw new CloudError(`No zone ${a.zone} on this Cloudflare account`);
  const existing = arr(await cf(fetchImpl, a.apiToken, `/zones/${zone.id}/dns_records?type=${a.type}&name=${encodeURIComponent(a.name)}`, a.timeoutMs))[0];
  if (a.action === "delete") {
    if (existing) await cf(fetchImpl, a.apiToken, `/zones/${zone.id}/dns_records/${existing.id}`, a.timeoutMs, { method: "DELETE" });
    return { name: a.name, type: a.type, deleted: !!existing };
  }
  if (!a.content) throw new CloudError("A record needs content");
  const body = JSON.stringify({ type: a.type, name: a.name, content: a.content, proxied: a.proxied, ttl: 1, comment: "Set by an approved MOSS change" });
  const rec = obj(existing ? await cf(fetchImpl, a.apiToken, `/zones/${zone.id}/dns_records/${existing.id}`, a.timeoutMs, { method: "PUT", body }) : await cf(fetchImpl, a.apiToken, `/zones/${zone.id}/dns_records`, a.timeoutMs, { method: "POST", body }));
  return { name: clean(rec.name), type: clean(rec.type), content: clean(rec.content), proxied: rec.proxied === true, created: !existing };
}
