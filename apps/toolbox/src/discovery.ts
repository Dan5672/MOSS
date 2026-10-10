// Discovery and diagnostics tools: UniFi clients, SNMP presets, traceroute and name lookups.
// Everything a device sends back is attacker-controllable, so text is cleaned and bounded here, and
// binaries get fixed argument lists (no shell) built from arguments the gate has already checked.
import type { NameLookupHost, NameLookupResult, SnmpResult, TracerouteResult, UnifiClient, UnifiClientsResult } from "@moss/tools";
import { XMLParser } from "fast-xml-parser";
import { request } from "node:https";
import { clean } from "./parsers.js";
import type { Exec } from "./runners.js";

export class DiscoveryError extends Error {}

const MAX_BODY = 5 * 1024 * 1024;
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const mac = (v: unknown) => {
  const m = clean(v)?.toLowerCase().replace(/-/g, ":");
  return m && MAC.test(m) ? m : undefined;
};

// --- UniFi ----------------------------------------------------------------------------------

export type HttpGet = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; body: string }>;

/**
 * GET over HTTPS. UniFi consoles ship a self-signed certificate, so it isn't verified. The address is a
 * literal IP the gate has scope-checked, and the API key is only ever sent to that address.
 */
export const httpsGet: HttpGet = (url, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new DiscoveryError("Response too large"));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new DiscoveryError("Timed out")));
    req.on("error", reject);
    req.end();
  });

interface UnifiPage<T> {
  data?: T[];
  offset?: number;
  limit?: number;
  totalCount?: number;
}

export async function unifiClients(
  a: { controller: string; apiKey: string; port: number; site: string; timeoutMs: number },
  get: HttpGet = httpsGet,
): Promise<UnifiClientsResult> {
  const base = `https://${a.controller.includes(":") ? `[${a.controller}]` : a.controller}:${a.port}/proxy/network/integration/v1`;
  const headers = { "X-API-KEY": a.apiKey, Accept: "application/json" };
  const fetchJson = async <T>(path: string): Promise<T> => {
    let res: { status: number; body: string };
    try {
      res = await get(base + path, headers, a.timeoutMs);
    } catch (err) {
      throw new DiscoveryError(`Could not reach the UniFi console: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new DiscoveryError("The UniFi console rejected the API key");
    if (res.status === 404) throw new DiscoveryError("No UniFi Network integration API here (needs UniFi Network 9.0 or later)");
    if (res.status !== 200) throw new DiscoveryError(`The UniFi console answered HTTP ${res.status}`);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new DiscoveryError("The UniFi console sent a response that isn't JSON");
    }
  };

  const sites = await fetchJson<UnifiPage<{ id?: string; internalReference?: string; name?: string }>>("/sites?limit=200");
  const site = (sites.data ?? []).find((s) => s.internalReference === a.site || s.name === a.site);
  if (!site?.id || !/^[0-9a-f-]{36}$/i.test(site.id)) {
    const known = (sites.data ?? []).map((s) => clean(s.internalReference)).filter(Boolean);
    throw new DiscoveryError(`No site "${a.site}" on this console${known.length ? ` (sites: ${known.join(", ")})` : ""}`);
  }

  const clients: UnifiClient[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const page = await fetchJson<UnifiPage<Record<string, unknown>>>(`/sites/${site.id}/clients?offset=${offset}&limit=200`);
    for (const c of page.data ?? []) {
      const ip = clean(c.ipAddress);
      clients.push({
        ip: ip && IPV4.test(ip) ? ip : undefined,
        mac: mac(c.macAddress),
        name: clean(c.name),
        type: clean(c.type)?.toLowerCase(),
        connectedAt: clean(c.connectedAt),
        uplinkDevice: clean(c.uplinkDeviceId),
      });
    }
    const total = page.totalCount ?? 0;
    if (!page.data?.length || offset + 200 >= total) break;
  }
  return {
    site: a.site,
    clients,
    hosts: clients.flatMap((c) => (c.ip ? [{ ip: c.ip, mac: c.mac, hostnames: c.name ? [c.name] : [], status: "up" as const }] : [])),
  };
}

// --- SNMP -----------------------------------------------------------------------------------

const SYSTEM = { "1.3.6.1.2.1.1.1.0": "description", "1.3.6.1.2.1.1.3.0": "uptime", "1.3.6.1.2.1.1.4.0": "contact", "1.3.6.1.2.1.1.5.0": "name", "1.3.6.1.2.1.1.6.0": "location" };

/** Table presets: each column is walked, then joined into rows by the OID index after the column OID. */
const TABLES: Record<string, Record<string, string>> = {
  interfaces: {
    "1.3.6.1.2.1.2.2.1.2": "name",
    "1.3.6.1.2.1.31.1.1.1.18": "alias",
    "1.3.6.1.2.1.2.2.1.8": "status",
    "1.3.6.1.2.1.31.1.1.1.15": "speedMbps",
    "1.3.6.1.2.1.31.1.1.1.6": "inOctets",
    "1.3.6.1.2.1.31.1.1.1.10": "outOctets",
  },
  lldp_neighbors: {
    "1.0.8802.1.1.2.1.4.1.1.9": "neighborName",
    "1.0.8802.1.1.2.1.4.1.1.8": "neighborPort",
    "1.0.8802.1.1.2.1.4.1.1.7": "neighborPortId",
    "1.0.8802.1.1.2.1.4.1.1.5": "neighborChassis",
  },
  storage: {
    "1.3.6.1.2.1.25.2.3.1.3": "description",
    "1.3.6.1.2.1.25.2.3.1.4": "unitBytes",
    "1.3.6.1.2.1.25.2.3.1.5": "size",
    "1.3.6.1.2.1.25.2.3.1.6": "used",
  },
};
const IF_STATUS: Record<string, string> = { "1": "up", "2": "down", "3": "testing", "5": "dormant", "6": "notPresent", "7": "lowerLayerDown" };
const MAX_ROWS = 200;

/** Parses net-snmp `-On -Oq -Ot` output: one "<numeric OID> <value>" per line. */
export function parseSnmpLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\.?([0-9.]+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (/^No (Such|more)/.test(value)) continue;
    out.set(m[1]!, clean(value) ?? "");
  }
  return out;
}

export async function snmpQuery(a: { target: string; community: string; preset: string; timeoutMs: number }, exec: Exec): Promise<SnmpResult> {
  const common = ["-v2c", "-c", a.community, "-On", "-Oq", "-Ot", "-t", String(Math.max(1, Math.round(a.timeoutMs / 1000))), "-r", "1", a.target];
  const fail = (stderr: string) => {
    if (/Timeout/i.test(stderr)) throw new DiscoveryError(`No SNMP answer from ${a.target} (wrong community, SNMP off, or blocked)`);
    throw new DiscoveryError(`SNMP failed: ${(clean(stderr) ?? "").replaceAll(a.community, "***")}`);
  };
  if (a.preset === "system") {
    const res = await exec("snmpget", [...common, ...Object.keys(SYSTEM)], a.timeoutMs + 5000);
    if (res.code !== 0 && !res.stdout.trim()) fail(res.stderr);
    const got = parseSnmpLines(res.stdout);
    const values = Object.fromEntries(Object.entries(SYSTEM).flatMap(([oid, key]) => (got.has(oid) ? [[key, got.get(oid)!]] : [])));
    if (values.uptime && /^\d+$/.test(values.uptime)) values.uptimeDays = (Number(values.uptime) / 8_640_000).toFixed(1);
    return { target: a.target, preset: a.preset, values };
  }
  const columns = TABLES[a.preset];
  if (!columns) throw new DiscoveryError(`Unknown preset ${a.preset}`);
  const rows = new Map<string, Record<string, string>>();
  for (const [oid, key] of Object.entries(columns)) {
    const res = await exec("snmpbulkwalk", [...common, oid], a.timeoutMs + 10_000);
    if (res.code !== 0 && !res.stdout.trim()) fail(res.stderr);
    for (const [full, value] of parseSnmpLines(res.stdout)) {
      if (!full.startsWith(`${oid}.`)) continue;
      const index = full.slice(oid.length + 1);
      if (!rows.has(index) && rows.size >= MAX_ROWS) continue;
      rows.set(index, { ...(rows.get(index) ?? { index }), [key]: value });
    }
  }
  const out = [...rows.values()].map((r) => {
    if (r.status) r.status = IF_STATUS[r.status] ?? r.status;
    if (r.unitBytes && r.size && r.used) {
      const unit = Number(r.unitBytes);
      r.sizeGb = ((Number(r.size) * unit) / 1e9).toFixed(1);
      r.usedGb = ((Number(r.used) * unit) / 1e9).toFixed(1);
      r.usedPercent = Number(r.size) ? ((Number(r.used) / Number(r.size)) * 100).toFixed(0) : "0";
    }
    return r;
  });
  return { target: a.target, preset: a.preset, values: {}, rows: out };
}

// --- traceroute -----------------------------------------------------------------------------

/** Parses `traceroute -n -q 1` output: " 3  10.0.0.1  4.123 ms" or " 4  *". */
export function parseTraceroute(target: string, text: string): TracerouteResult {
  const hops: TracerouteResult["hops"] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(?:(\*)|([0-9a-fA-F:.]+)\s+([\d.]+)\s*ms)/.exec(line);
    if (!m) continue;
    hops.push({ hop: Number(m[1]), ip: m[2] ? null : m[3]!, rttMs: m[4] ? Number(m[4]) : null });
  }
  return { target, reached: hops.some((h) => h.ip === target), hops };
}

export async function traceroute(a: { target: string; maxHops: number }, exec: Exec): Promise<TracerouteResult> {
  const res = await exec("traceroute", ["-n", "-q", "1", "-w", "2", "-m", String(a.maxHops), a.target], 90_000);
  if (res.code !== 0 && !res.stdout.trim()) throw new DiscoveryError(`traceroute failed: ${clean(res.stderr) ?? ""}`);
  return parseTraceroute(a.target, res.stdout);
}

// --- Name lookups (NetBIOS, mDNS, UPnP via nmap scripts) ------------------------------------

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (_n, jpath) =>
    ["nmaprun.host", "nmaprun.host.address", "nmaprun.host.hostscript.script", "nmaprun.host.ports.port", "nmaprun.host.ports.port.script"].includes(String(jpath)),
  processEntities: false,
});

/**
 * Decodes the five predefined XML entities and numeric character references in an attribute value.
 * The parser leaves entities alone on purpose (no DOCTYPE expansion), so this is all that's decoded.
 */
export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#d{1,7}|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

const field = (output: string, label: string) => clean(new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi").exec(output)?.[1]);

/** Parses the nbstat, dns-service-discovery and upnp-info script results from nmap XML. */
export function parseNameLookupXml(text: string): NameLookupResult {
  const doc = xml.parse(text) as { nmaprun?: { host?: any[] } };
  const found: NameLookupHost[] = [];
  for (const h of (doc.nmaprun?.host ?? []) as any[]) {
    const ip = (h.address ?? []).find((x: any) => x.addrtype === "ipv4" || x.addrtype === "ipv6")?.addr as string | undefined;
    if (!ip) continue;
    const scripts: { id: string; output: string }[] = [
      ...(h.hostscript?.script ?? []),
      ...(h.ports?.port ?? []).flatMap((p: any) => p.script ?? []),
    ].map((s: any) => ({ id: String(s.id), output: decodeXmlText(String(s.output ?? "")) }));
    const entry: NameLookupHost = { ip };
    for (const s of scripts) {
      if (s.id === "nbstat") {
        const name = /NetBIOS name:\s*([^,\s]+)/.exec(s.output)?.[1];
        const user = /NetBIOS user:\s*([^,\s]+)/.exec(s.output)?.[1];
        const m = /NetBIOS MAC:\s*([0-9a-fA-F:]{17})/.exec(s.output)?.[1];
        if (name && !/^<.*>$/.test(name)) entry.netbiosName = clean(name)?.slice(0, 63);
        if (user && !/^<.*>$/.test(user)) entry.netbiosUser = clean(user)?.slice(0, 63);
        if (m) entry.mac = mac(m);
      } else if (s.id === "dns-service-discovery") {
        const services = [...s.output.matchAll(/^\s*\d+\/(?:tcp|udp)\s+([A-Za-z0-9_.-]+)\s*$/gm)].map((m) => m[1]!);
        if (services.length) entry.mdnsServices = [...new Set(services)].slice(0, 20);
      } else if (s.id === "upnp-info") {
        const upnp = {
          server: field(s.output, "Server"),
          friendlyName: field(s.output, "Name"),
          manufacturer: field(s.output, "Manufacturer"),
          model: field(s.output, "Model Name"),
        };
        if (Object.values(upnp).some(Boolean)) entry.upnp = Object.fromEntries(Object.entries(upnp).filter(([, v]) => v)) as NameLookupHost["upnp"];
      }
    }
    if (entry.netbiosName || entry.mdnsServices || entry.upnp) found.push(entry);
  }
  return {
    found,
    hosts: found.map((f) => ({
      ip: f.ip,
      mac: f.mac,
      hostnames: [f.netbiosName?.toLowerCase(), f.upnp?.friendlyName].filter((n): n is string => !!n),
      status: "up" as const,
    })),
  };
}

export async function nameLookup(a: { targets: string[] }, exec: Exec): Promise<NameLookupResult> {
  const flags = ["-sU", "-Pn", "-n", "-p", "U:137,U:1900,U:5353", "--script", "nbstat,dns-service-discovery,upnp-info", "--script-timeout", "20s", "--privileged", "-oX", "-"];
  const res = await exec("nmap", [...flags, ...a.targets], 10 * 60_000);
  if (res.code !== 0 && !res.stdout.includes("<nmaprun")) throw new DiscoveryError(`nmap failed: ${clean(res.stderr) ?? ""}`);
  return parseNameLookupXml(res.stdout);
}
