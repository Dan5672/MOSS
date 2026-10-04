// Parsers for tool output. Everything coming back from the network (hostnames,
// vendors, service banners) is attacker-controllable, so text is sanitized and bounded here.
import type { ArpScanResult, NmapResult, PingResult, ScannedHost } from "@moss/tools";
import { XMLParser } from "fast-xml-parser";

const MAX_FIELD = 255;

/** Strips control characters and caps length so tool output can't smuggle in terminal escapes or huge blobs. */
export function clean(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // eslint-disable-next-line no-control-regex
  const s = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return s ? s.slice(0, MAX_FIELD) : undefined;
}

const ARRAY_PATHS = new Set(["nmaprun.host", "nmaprun.host.address", "nmaprun.host.hostnames.hostname", "nmaprun.host.ports.port"]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (_name, jpath) => ARRAY_PATHS.has(String(jpath)),
  // Never expand entities from untrusted XML.
  processEntities: false,
});

type Attrs = Record<string, string | undefined>;

export function parseNmapXml(text: string): NmapResult {
  const doc = xml.parse(text) as { nmaprun?: { host?: Attrs[]; runstats?: { finished?: Attrs } } };
  const run = doc.nmaprun;
  if (!run) throw new Error("nmap produced no XML report");
  const hosts: ScannedHost[] = [];
  for (const h of (run.host ?? []) as any[]) {
    const addresses = (h.address ?? []) as Attrs[];
    const ip = addresses.find((a) => a.addrtype === "ipv4" || a.addrtype === "ipv6")?.addr;
    if (!ip) continue;
    const mac = addresses.find((a) => a.addrtype === "mac");
    hosts.push({
      ip,
      status: h.status?.state === "up" ? "up" : "down",
      mac: clean(mac?.addr)?.toLowerCase(),
      vendor: clean(mac?.vendor),
      hostnames: ((h.hostnames?.hostname ?? []) as Attrs[]).flatMap((n) => clean(n.name) ?? []).slice(0, 10),
      ports: ((h.ports?.port ?? []) as any[]).map((p) => ({
        protocol: p.protocol === "udp" ? "udp" : "tcp",
        port: Number(p.portid),
        state: clean(p.state?.state) ?? "unknown",
        service: clean(p.service?.name),
        product: clean(p.service?.product),
        version: clean(p.service?.version),
      })),
    });
  }
  const elapsed = Number(run.runstats?.finished?.elapsed);
  return { hosts, ...(Number.isFinite(elapsed) ? { elapsedSeconds: elapsed } : {}) };
}

const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Parses `arp-scan --plain` output: one "ip<TAB>mac<TAB>vendor" line per reply. */
export function parseArpScan(text: string): ArpScanResult {
  const seen = new Map<string, ArpScanResult["hosts"][number]>();
  for (const line of text.split(/\r?\n/)) {
    const [ip, mac, ...vendor] = line.split("\t");
    if (!ip || !mac || !IPV4.test(ip) || !MAC.test(mac)) continue;
    if (!seen.has(ip)) seen.set(ip, { ip, mac: mac.toLowerCase(), vendor: clean(vendor.join(" ")) });
  }
  return { hosts: [...seen.values()] };
}

/** Parses iputils ping summary lines. */
export function parsePing(target: string, text: string): PingResult {
  const stats = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(text);
  const rtt = /= [\d.]+\/([\d.]+)\/[\d.]+/.exec(text);
  const transmitted = Number(stats?.[1] ?? 0);
  const received = Number(stats?.[2] ?? 0);
  return {
    target,
    transmitted,
    received,
    lossPercent: transmitted ? Math.round(((transmitted - received) / transmitted) * 100) : 100,
    ...(rtt?.[1] ? { rttAvgMs: Number(rtt[1]) } : {}),
  };
}
