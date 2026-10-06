// Executes built-in tools. Binaries are invoked with execFile and fixed argument lists:
// no shell, and every user-supplied value has already passed strict schema validation.
import { contains, parseRange } from "@moss/policy";
import { BUILT_IN_TOOLS, customHttp as customHttpTool, parseToolArgs, type RenderedRequest } from "@moss/tools";
import { customHttp, sendRequest, type RawRequest } from "./custom-http.js";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import { networkInterfaces } from "node:os";
import { DiscoveryError, httpsGet, nameLookup, snmpQuery, traceroute, unifiClients, type HttpGet } from "./discovery.js";
import { parseArpScan, parseNmapXml, parsePing } from "./parsers.js";
import { httpProbe, tcpConnect, tlsInspect, type HttpProbeArgs } from "./probes.js";

const NMAP_PROFILES: Record<string, string[]> = {
  ping: ["-sn"],
  top100: ["-sS", "--top-ports", "100", "-T4"],
  services: ["-sS", "-sV", "--top-ports", "1000", "-T4"],
};

/** Host discovery by ICMP echo and timestamp only, for when TCP replies can't be trusted. */
const ICMP_DISCOVERY = ["-PE", "-PP"];
/** Host-up reasons that come from TCP probes. */
const TCP_REASONS = new Set(["reset", "syn-ack"]);

// Some network paths answer TCP probes for every address themselves: Docker Desktop's NAT replies
// with a reset for addresses where nothing exists, so nmap's default discovery reports every address
// up. Once that is seen, discovery uses ICMP only for the life of the process.
let tcpRepliesUntrusted = false;

/** Test hook. */
export function resetDiscoveryState() {
  tcpRepliesUntrusted = false;
}

/** The network and broadcast addresses of IPv4 CIDR targets: no real host answers as them. */
function reservedAddresses(targets: string[]): Set<bigint> {
  const out = new Set<bigint>();
  for (const t of targets) {
    const range = parseRange(t)!;
    if (range.version === 4 && range.end - range.start >= 3n) out.add(range.start).add(range.end);
  }
  return out;
}

export class ToolError extends Error {}

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new ToolError(`${file} is not installed`));
      if (err?.killed) return reject(new ToolError(`${file} timed out`));
      const code = typeof err?.code === "number" ? err.code : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export type InterfaceLister = () => { name: string; cidr: string }[];

export const listInterfaces: InterfaceLister = () =>
  Object.entries(networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal && a.cidr).map((a) => ({ name, cidr: a.cidr! })),
  );

/**
 * ARP only works on a directly attached subnet, and the toolbox is usually on several
 * networks, so pick the interface whose subnet contains every target.
 */
export function attachedInterface(targets: string[], interfaces: { name: string; cidr: string }[]): string {
  let chosen: string | undefined;
  for (const t of targets) {
    const range = parseRange(t)!;
    const match = interfaces.find((i) => {
      const net = parseRange(i.cidr);
      return net !== null && contains(net, range);
    });
    if (!match) throw new ToolError(`${t} is not on a subnet directly attached to the toolbox; use nmap_scan instead`);
    if (chosen && chosen !== match.name) throw new ToolError("arp_scan targets must all be on the same attached subnet");
    chosen = match.name;
  }
  return chosen!;
}

/** Wake-on-LAN magic packet: 6 x 0xFF followed by the MAC address repeated 16 times. */
export function magicPacket(mac: string): Buffer {
  const macBytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  if (macBytes.length !== 6) throw new ToolError("Invalid MAC address");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(macBytes)]);
}

export type UdpSender = (packet: Buffer, address: string, port: number, times: number) => Promise<void>;

export let sendUdp: UdpSender = async (packet, address, port, times) => {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => socket.bind(0, () => resolve()).once("error", reject));
    socket.setBroadcast(true);
    for (let i = 0; i < times; i++) {
      await new Promise<void>((resolve, reject) => socket.send(packet, port, address, (err) => (err ? reject(err) : resolve())));
    }
  } finally {
    socket.close();
  }
};

/** Test hook. */
export function setUdpSender(sender: UdpSender) {
  sendUdp = sender;
}

/** Defense in depth: even though the gate checked scope, never pass anything but a literal IP/CIDR to a binary. */
function assertTargets(targets: string[]) {
  for (const t of targets) if (!parseRange(t)) throw new ToolError(`Refusing non-IP target ${JSON.stringify(t)}`);
}

function assertHost(target: string) {
  const range = parseRange(target);
  if (!range || range.start !== range.end) throw new ToolError(`Refusing target ${JSON.stringify(target)}: must be a single IP`);
}

export async function runTool(
  name: string,
  rawArgs: unknown,
  exec: Exec = defaultExec,
  interfaces: InterfaceLister = listInterfaces,
  get: HttpGet = httpsGet,
  send: RawRequest = sendRequest,
): Promise<unknown> {
  try {
    return await runToolInner(name, rawArgs, exec, interfaces, get, send);
  } catch (err) {
    // Discovery tools report device-side problems (bad key, no answer) as tool errors, not crashes.
    if (err instanceof DiscoveryError) throw new ToolError(err.message);
    throw err;
  }
}

async function runToolInner(name: string, rawArgs: unknown, exec: Exec, interfaces: InterfaceLister, get: HttpGet, send: RawRequest): Promise<unknown> {
  // custom_http is internal: only the gate sends it, with a request it rendered after the policy allowed it.
  const def = name === "custom_http" ? customHttpTool : BUILT_IN_TOOLS.get(name);
  if (!def) throw new ToolError(`Unknown tool ${name}`);
  const parsed = parseToolArgs(def, rawArgs);
  if (!parsed.ok) throw new ToolError(`Invalid arguments: ${parsed.error}`);
  const args = parsed.args;

  switch (name) {
    case "nmap_scan": {
      const targets = args.targets as string[];
      assertTargets(targets);
      const scan = async (icmpOnly: boolean) => {
        const flags = [...NMAP_PROFILES[args.profile as string]!, ...(icmpOnly ? ICMP_DISCOVERY : []), "--privileged", "-oX", "-", ...targets];
        const res = await exec("nmap", flags, 15 * 60_000);
        if (res.code !== 0 && !res.stdout.includes("<nmaprun")) throw new ToolError(`nmap failed: ${res.stderr.slice(0, 500)}`);
        return parseNmapXml(res.stdout);
      };
      const reserved = reservedAddresses(targets);
      const isReserved = (ip: string) => reserved.has(parseRange(ip)?.start ?? -1n);
      let result = await scan(tcpRepliesUntrusted);
      if (!tcpRepliesUntrusted && result.hosts.some((h) => h.status === "up" && isReserved(h.ip) && TCP_REASONS.has(h.reason ?? ""))) {
        tcpRepliesUntrusted = true;
        result = await scan(true);
      }
      return {
        ...result,
        hosts: result.hosts.filter((h) => !isReserved(h.ip)),
        ...(tcpRepliesUntrusted && {
          warning:
            "TCP replies on this network path are unreliable (something answers for addresses where no host exists), " +
            "so hosts were discovered by ICMP only. Hosts that block ping will not be listed.",
        }),
      };
    }
    case "arp_scan": {
      const targets = args.targets as string[];
      assertTargets(targets);
      if (targets.some((t) => parseRange(t)!.version !== 4)) throw new ToolError("arp_scan supports IPv4 only");
      const iface = attachedInterface(targets, interfaces());
      const res = await exec("arp-scan", ["--plain", "--retry=2", `--interface=${iface}`, ...targets], 5 * 60_000);
      if (res.code !== 0) throw new ToolError(`arp-scan failed: ${res.stderr.slice(0, 500)}`);
      return parseArpScan(res.stdout);
    }
    case "ping": {
      const target = args.target as string;
      assertTargets([target]);
      if (target.includes("/")) throw new ToolError("ping takes a single host, not a CIDR");
      const res = await exec("ping", ["-c", String(args.count), "-W", "2", target], 60_000);
      return parsePing(target, res.stdout);
    }
    case "wake_on_lan": {
      const broadcast = args.broadcast as string;
      assertTargets([broadcast]);
      const range = parseRange(broadcast)!;
      if (range.version !== 4 || range.start !== range.end) throw new ToolError("broadcast must be a single IPv4 address");
      const mac = (args.mac as string).toLowerCase();
      await sendUdp(magicPacket(mac), broadcast, args.port as number, 3);
      return { mac, broadcast, packetsSent: 3 };
    }
    case "dns_lookup": {
      const nameArg = args.name as string;
      const type = args.type as "A" | "AAAA" | "PTR";
      try {
        const answers =
          type === "PTR" ? await dns.reverse(nameArg) : type === "AAAA" ? await dns.resolve6(nameArg) : await dns.resolve4(nameArg);
        return { name: nameArg, type, answers: answers.slice(0, 32) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTFOUND" || code === "ENODATA") return { name: nameArg, type, answers: [] };
        throw new ToolError(`DNS lookup failed: ${code ?? String(err)}`);
      }
    }
    case "tcp_connect": {
      const target = args.target as string;
      assertHost(target);
      return tcpConnect(target, args.port as number, args.timeoutMs as number);
    }
    case "http_probe": {
      assertHost(args.target as string);
      return httpProbe(args as unknown as HttpProbeArgs);
    }
    case "tls_inspect": {
      const target = args.target as string;
      assertHost(target);
      return tlsInspect(target, args.port as number, args.servername as string | undefined, args.timeoutMs as number);
    }
    case "custom_http": {
      assertHost(args.target as string);
      try {
        return await customHttp(args as unknown as RenderedRequest, send);
      } catch (err) {
        throw new ToolError(`Request failed: ${(err as Error).message}`);
      }
    }
    case "unifi_clients": {
      assertHost(args.controller as string);
      return unifiClients(args as Parameters<typeof unifiClients>[0], get);
    }
    case "snmp_query": {
      assertHost(args.target as string);
      return snmpQuery(args as Parameters<typeof snmpQuery>[0], exec);
    }
    case "traceroute": {
      assertHost(args.target as string);
      return traceroute(args as Parameters<typeof traceroute>[0], exec);
    }
    case "name_lookup": {
      const targets = args.targets as string[];
      assertTargets(targets);
      for (const t of targets) {
        const r = parseRange(t)!;
        if (r.end - r.start > 255n) throw new ToolError(`${t} is too large for name_lookup; use /24 or smaller`);
      }
      return nameLookup({ targets }, exec);
    }
    default:
      throw new ToolError(`Tool ${name} has no runner`);
  }
}
