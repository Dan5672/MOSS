// Executes built-in tools. Binaries are invoked with execFile and fixed argument lists:
// no shell, and every user-supplied value has already passed strict schema validation.
import { contains, parseRange } from "@moss/policy";
import { BUILT_IN_TOOLS, parseToolArgs } from "@moss/tools";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import { networkInterfaces } from "node:os";
import { parseArpScan, parseNmapXml, parsePing } from "./parsers.js";

const NMAP_PROFILES: Record<string, string[]> = {
  ping: ["-sn"],
  top100: ["-sS", "--top-ports", "100", "-T4"],
  services: ["-sS", "-sV", "--top-ports", "1000", "-T4"],
};

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

export async function runTool(
  name: string,
  rawArgs: unknown,
  exec: Exec = defaultExec,
  interfaces: InterfaceLister = listInterfaces,
): Promise<unknown> {
  const def = BUILT_IN_TOOLS.get(name);
  if (!def) throw new ToolError(`Unknown tool ${name}`);
  const parsed = parseToolArgs(def, rawArgs);
  if (!parsed.ok) throw new ToolError(`Invalid arguments: ${parsed.error}`);
  const args = parsed.args;

  switch (name) {
    case "nmap_scan": {
      const targets = args.targets as string[];
      assertTargets(targets);
      const flags = [...NMAP_PROFILES[args.profile as string]!, "--privileged", "-oX", "-", ...targets];
      const res = await exec("nmap", flags, 15 * 60_000);
      if (res.code !== 0 && !res.stdout.includes("<nmaprun")) throw new ToolError(`nmap failed: ${res.stderr.slice(0, 500)}`);
      return parseNmapXml(res.stdout);
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
    default:
      throw new ToolError(`Tool ${name} has no runner`);
  }
}
