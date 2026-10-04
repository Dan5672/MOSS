// Built-in tool catalog: one definition per tool, shared by the gate (policy + LLM
// tool specs) and the toolbox (argument validation). Arguments are strict, typed and
// bounded, and there is deliberately no generic "run a command" tool.
import { z } from "zod";
import type { ToolManifest } from "@moss/policy";

const ipOrCidr = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[0-9A-Fa-f:.]+(\/\d{1,3})?$/, "Must be an IP address or CIDR (resolve hostnames with dns_lookup first)");

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  manifest: ToolManifest;
  description: string;
  args: S;
}

function tool<S extends z.ZodObject>(manifest: ToolManifest, description: string, args: S): ToolDefinition<S> {
  return { manifest, description, args: args.strict() as unknown as S };
}

export const nmapScan = tool(
  { name: "nmap_scan", class: "read", targetArgs: ["targets"] },
  "Scan hosts with nmap. Profiles: 'ping' (host discovery only), 'top100' (100 most common TCP ports), " +
    "'services' (top 1000 TCP ports with service/version detection; slower). Targets must be inside allowed networks.",
  z.object({
    targets: z.array(ipOrCidr).min(1).max(16),
    profile: z.enum(["ping", "top100", "services"]),
  }),
);

export const arpScan = tool(
  { name: "arp_scan", class: "read", targetArgs: ["targets"] },
  "Discover devices on a directly attached IPv4 subnet using ARP. Returns IP, MAC and NIC vendor. " +
    "Only works for subnets the toolbox is directly connected to.",
  z.object({ targets: z.array(ipOrCidr).min(1).max(8) }),
);

export const ping = tool(
  { name: "ping", class: "read", targetArgs: ["target"] },
  "Send ICMP echo requests to a single host and report packet loss and round-trip time.",
  z.object({ target: ipOrCidr, count: z.number().int().min(1).max(10).default(3) }),
);

export const dnsLookup = tool(
  { name: "dns_lookup", class: "read", targetArgs: [] },
  "Resolve a hostname to IP addresses (A/AAAA), or an IP to hostnames (PTR), using the toolbox's resolver.",
  z.object({
    name: z.string().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/, "Invalid hostname or IP"),
    type: z.enum(["A", "AAAA", "PTR"]).default("A"),
  }),
);

export const wakeOnLan = tool(
  { name: "wake_on_lan", class: "write", targetArgs: ["broadcast"] },
  "Power on a device by sending a Wake-on-LAN magic packet to its MAC address via the subnet's broadcast address. " +
    "Changes device state, so it only runs as part of an approved change.",
  z.object({
    mac: z.string().regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, "Must be a MAC address"),
    broadcast: ipOrCidr.describe("Broadcast address of the device's subnet, e.g. 192.168.1.255"),
    port: z.union([z.literal(7), z.literal(9)]).default(9),
  }),
);

export const BUILT_IN_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map(
  [nmapScan, arpScan, ping, dnsLookup, wakeOnLan].map((t) => [t.manifest.name, t as unknown as ToolDefinition]),
);

/** The JSON Schema handed to the LLM for a tool's input. */
export function toolInputSchema(def: ToolDefinition): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(def.args, { io: "input" }) as Record<string, unknown>;
  return schema;
}

export type ParsedArgs = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArgs(def: ToolDefinition, raw: unknown): ParsedArgs {
  const res = def.args.safeParse(raw);
  if (res.success) return { ok: true, args: res.data as Record<string, unknown> };
  return { ok: false, error: z.prettifyError(res.error) };
}

// --- Result shapes returned by the toolbox ------------------------------------------------

export interface ScannedPort {
  protocol: "tcp" | "udp";
  port: number;
  state: string;
  service?: string;
  product?: string;
  version?: string;
}

export interface ScannedHost {
  ip: string;
  status: "up" | "down";
  mac?: string;
  vendor?: string;
  hostnames: string[];
  ports: ScannedPort[];
}

export interface NmapResult {
  hosts: ScannedHost[];
  elapsedSeconds?: number;
}

export interface ArpScanResult {
  hosts: { ip: string; mac: string; vendor?: string }[];
}

export interface PingResult {
  target: string;
  transmitted: number;
  received: number;
  lossPercent: number;
  rttAvgMs?: number;
}

export interface WakeOnLanResult {
  mac: string;
  broadcast: string;
  packetsSent: number;
}

export interface DnsLookupResult {
  name: string;
  type: "A" | "AAAA" | "PTR";
  answers: string[];
}
