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

// --- Service probes (used by monitors and by agents) ---------------------------------------
// They connect to a literal IP. A hostname, when needed, only travels as the Host header or
// TLS SNI, so DNS answers can never steer a probe outside the scope the gate checked.
const hostIp = z
  .string()
  .min(2)
  .max(45)
  .regex(/^[0-9A-Fa-f:.]+$/, "Must be a single IP address (resolve hostnames with dns_lookup first)");
const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/, "Must be a hostname");
const port = z.number().int().min(1).max(65535);
const timeoutMs = z.number().int().min(500).max(30_000).default(10_000);

export const tcpConnect = tool(
  { name: "tcp_connect", class: "read", targetArgs: ["target"] },
  "Open a TCP connection to one port on a host and report whether it was accepted and how long it took. Sends no data.",
  z.object({ target: hostIp, port, timeoutMs }),
);

export const httpProbe = tool(
  { name: "http_probe", class: "read", targetArgs: ["target"] },
  "Make one HTTP(S) request to a host and report the status code, latency and whether an optional keyword appears in the " +
    "first 256 KB of the body. Does not follow redirects. Use hostHeader for virtual hosts (also used as TLS SNI).",
  z.object({
    target: hostIp,
    port: port.optional(),
    scheme: z.enum(["http", "https"]).default("http"),
    path: z
      .string()
      .max(512)
      .regex(/^\/[\x21-\x7e]*$/, "Must be an absolute path without spaces")
      .default("/"),
    hostHeader: hostname.optional(),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    expectStatus: z.array(z.number().int().min(100).max(599)).max(16).optional(),
    keyword: z.string().min(1).max(200).optional(),
    verifyTls: z.boolean().default(true),
    timeoutMs,
  }),
);

export const tlsInspect = tool(
  { name: "tls_inspect", class: "read", targetArgs: ["target"] },
  "Fetch the TLS certificate a host presents and report its subject, issuer, names, expiry and whether the chain is trusted.",
  z.object({ target: hostIp, port: port.default(443), servername: hostname.optional(), timeoutMs }),
);

// --- Discovery and diagnostics ------------------------------------------------------------
// Credentials are passed as secret:<name> handles. The gate checks the agent's grant and the secret's
// host/tool scope, substitutes the value for the toolbox, and scrubs it from the result.
const secretHandle = z
  .string()
  .min(1)
  .max(4096)
  .describe("A stored secret, written as secret:<name>. Never a literal password or key.");

export const unifiClients = tool(
  { name: "unifi_clients", class: "read", targetArgs: ["controller"], secretArgs: ["apiKey"] },
  "List the clients a UniFi console knows about (its official local API): IP, MAC, name, wired or Wi-Fi, and when each " +
    "connected. The best way to name devices and learn their MACs. Needs an API key stored as a secret. Results are added " +
    "to the inventory.",
  z.object({
    controller: hostIp.describe("The UniFi console or gateway, e.g. 10.0.0.1"),
    apiKey: secretHandle,
    port: port.default(443),
    site: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .default("default")
      .describe("Site name (internalReference), usually 'default'"),
    timeoutMs,
  }),
);

export const snmpQuery = tool(
  { name: "snmp_query", class: "read", targetArgs: ["target"], secretArgs: ["community"] },
  "Read standard SNMP (v2c) data from a device. Presets: 'system' (description, name, uptime, location), 'interfaces' " +
    "(names, status, speed, traffic counters), 'lldp_neighbors' (what each port is plugged into), 'storage' (disks and " +
    "memory). The community string must be a stored secret.",
  z.object({
    target: hostIp,
    community: secretHandle,
    preset: z.enum(["system", "interfaces", "lldp_neighbors", "storage"]),
    timeoutMs,
  }),
);

export const traceroute = tool(
  { name: "traceroute", class: "read", targetArgs: ["target"] },
  "Trace the network path to a host: each hop's address and round-trip time, to find where latency or loss starts. " +
    "The target must be in an allowed network (add e.g. 1.1.1.1/32 to trace towards the internet).",
  z.object({ target: hostIp, maxHops: z.number().int().min(1).max(30).default(20) }),
);

export const nameLookup = tool(
  { name: "name_lookup", class: "read", targetArgs: ["targets"] },
  "Ask devices their own names with unicast NetBIOS, mDNS (Bonjour) and UPnP queries. Finds names for PCs, printers, " +
    "TVs, speakers and IoT devices that DNS doesn't know. Names found are added to the inventory.",
  z.object({ targets: z.array(ipOrCidr).min(1).max(8).describe("IPs or small CIDRs (at most /24)") }),
);

// --- Servers over SSH ------------------------------------------------------------------------
// Each tool runs one fixed, read-only command; nothing from the agent reaches the remote shell except a
// validated service name. Logins are key-based only, so a device impersonating a server can't capture a
// password. The server's host key fingerprint is always reported and can be pinned.
const sshArgs = {
  target: hostIp,
  user: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/, "Must be a Unix user name")
    .describe("The account to log in as (a read-only account is best)"),
  key: secretHandle.describe("An SSH private key stored as a secret, as secret:<name>. Passwords are not supported."),
  port: port.default(22),
  hostKeySha256: z
    .string()
    .regex(/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/, "An SSH SHA256 fingerprint")
    .optional()
    .describe("The server's expected host key fingerprint; the connection is refused if it differs"),
  timeoutMs,
};

export const hostFacts = tool(
  { name: "host_facts", class: "read", targetArgs: ["target"], secretArgs: ["key"] },
  "Log in to a Linux server over SSH and report its OS, kernel, hostname, uptime, CPU count, memory and load.",
  z.object(sshArgs),
);

export const diskUsage = tool(
  { name: "disk_usage", class: "read", targetArgs: ["target"], secretArgs: ["key"] },
  "Report each mounted filesystem's size, use and free space on a Linux server, over SSH.",
  z.object(sshArgs),
);

export const serviceStatus = tool(
  { name: "service_status", class: "read", targetArgs: ["target"], secretArgs: ["key"] },
  "Report a systemd service's state on a Linux server over SSH: active or failed, since when, and whether it's enabled.",
  z.object({
    ...sshArgs,
    service: z
      .string()
      .regex(/^[A-Za-z0-9@._:-]{1,100}$/, "A systemd unit name, e.g. nginx or nginx.service")
      .describe("The systemd unit, e.g. nginx"),
  }),
);

export const dockerPs = tool(
  { name: "docker_ps", class: "read", targetArgs: ["target"], secretArgs: ["key"] },
  "List the Docker containers on a server over SSH: name, image, state and status. The account must be allowed to use Docker.",
  z.object({ ...sshArgs, all: z.boolean().default(true).describe("Include stopped containers") }),
);

// --- Home lab APIs ---------------------------------------------------------------------------
// Read-only calls to each product's own API. Home lab devices usually have self-signed certificates,
// so TLS verification is off by default; the address is a literal IP the gate has scope-checked.
const apiCommon = {
  target: hostIp,
  verifyTls: z.boolean().default(false).describe("Verify the device's TLS certificate (most home lab devices are self-signed)"),
  timeoutMs,
};

export const proxmoxStatus = tool(
  { name: "proxmox_status", class: "read", targetArgs: ["target"], secretArgs: ["token"] },
  "Read a Proxmox VE cluster: each node's status, CPU, memory and disk, and every VM and container's state and usage.",
  z.object({
    ...apiCommon,
    token: secretHandle.describe("A Proxmox API token stored as a secret, in the form USER@REALM!TOKENID=SECRET"),
    port: port.default(8006),
  }),
);

export const truenasStatus = tool(
  { name: "truenas_status", class: "read", targetArgs: ["target"], secretArgs: ["apiKey"] },
  "Read a TrueNAS system: version and uptime, each storage pool's health, and active alerts.",
  z.object({ ...apiCommon, apiKey: secretHandle.describe("A TrueNAS API key stored as a secret"), port: port.default(443) }),
);

export const synologyStatus = tool(
  { name: "synology_status", class: "read", targetArgs: ["target"], secretArgs: ["password"] },
  "Read a Synology NAS (DSM): model, version and temperature, each volume's status and use, and each disk's health.",
  z.object({
    ...apiCommon,
    user: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.@-]+$/).describe("A DSM account (a read-only one is best)"),
    password: secretHandle.describe("That account's password stored as a secret"),
    port: port.default(5001),
  }),
);

export const homeassistantStates = tool(
  { name: "homeassistant_states", class: "read", targetArgs: ["target"], secretArgs: ["token"] },
  "Read entity states from Home Assistant (sensors, switches, UPS, batteries...), optionally one domain such as sensor or switch.",
  z.object({
    ...apiCommon,
    token: secretHandle.describe("A Home Assistant long-lived access token stored as a secret"),
    port: port.default(8123),
    scheme: z.enum(["http", "https"]).default("http"),
    domain: z
      .string()
      .regex(/^[a-z_]{1,32}$/)
      .optional()
      .describe("Only this domain, e.g. sensor, switch, binary_sensor"),
    limit: z.number().int().min(1).max(500).default(200),
  }),
);

export const piholeSummary = tool(
  { name: "pihole_summary", class: "read", targetArgs: ["target"], secretArgs: ["password"] },
  "Read Pi-hole (v6) statistics: queries today, how many were blocked, active clients, and the busiest clients.",
  z.object({
    ...apiCommon,
    password: secretHandle.describe("The Pi-hole web or app password stored as a secret"),
    port: port.default(80),
    scheme: z.enum(["http", "https"]).default("http"),
  }),
);

export const adguardStats = tool(
  { name: "adguard_stats", class: "read", targetArgs: ["target"], secretArgs: ["password"] },
  "Read AdGuard Home statistics: queries, how many were blocked, average processing time, and the busiest clients.",
  z.object({
    ...apiCommon,
    user: z.string().min(1).max(64).describe("The AdGuard Home user name"),
    password: secretHandle.describe("That user's password stored as a secret"),
    port: port.default(80),
    scheme: z.enum(["http", "https"]).default("http"),
  }),
);

export const BUILT_IN_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map(
  [
    nmapScan,
    arpScan,
    ping,
    dnsLookup,
    wakeOnLan,
    tcpConnect,
    httpProbe,
    tlsInspect,
    unifiClients,
    snmpQuery,
    traceroute,
    nameLookup,
    hostFacts,
    diskUsage,
    serviceStatus,
    dockerPs,
    proxmoxStatus,
    truenasStatus,
    synologyStatus,
    homeassistantStates,
    piholeSummary,
    adguardStats,
  ].map((t) => [t.manifest.name, t as unknown as ToolDefinition]),
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

export interface UnifiClient {
  ip?: string;
  mac?: string;
  name?: string;
  type?: string;
  connectedAt?: string;
  uplinkDevice?: string;
}

export interface UnifiClientsResult {
  site: string;
  /** Inventory-shaped hosts (only clients with an IP), so they are added to the inventory. */
  hosts: { ip: string; mac?: string; hostnames: string[]; status: "up" }[];
  clients: UnifiClient[];
}

export interface SnmpResult {
  target: string;
  preset: string;
  values: Record<string, string>;
  rows?: Record<string, string>[];
}

export interface TracerouteResult {
  target: string;
  reached: boolean;
  hops: { hop: number; ip: string | null; rttMs: number | null }[];
}

export interface NameLookupHost {
  ip: string;
  netbiosName?: string;
  netbiosUser?: string;
  mac?: string;
  mdnsServices?: string[];
  upnp?: { server?: string; friendlyName?: string; manufacturer?: string; model?: string };
}

export interface NameLookupResult {
  /** Inventory-shaped hosts (only hosts that answered with a name), so names reach the inventory. */
  hosts: { ip: string; mac?: string; hostnames: string[]; status: "up" }[];
  found: NameLookupHost[];
}

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
  /** Why nmap considers the host up or down, e.g. "echo-reply", "arp-response", "reset". */
  reason?: string;
  mac?: string;
  vendor?: string;
  hostnames: string[];
  ports: ScannedPort[];
}

export interface NmapResult {
  hosts: ScannedHost[];
  elapsedSeconds?: number;
  /** Set when the scan had to work around an unreliable network path. */
  warning?: string;
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

export interface TcpConnectResult {
  target: string;
  port: number;
  open: boolean;
  latencyMs: number;
  error?: string;
}

export interface HttpProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  keywordFound?: boolean;
  /** Redirect target, if any (not followed). */
  location?: string;
  error?: string;
}

export interface TlsInspectResult {
  target: string;
  port: number;
  subject?: string;
  issuer?: string;
  altNames: string[];
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  trusted: boolean;
  trustError?: string;
  latencyMs: number;
  error?: string;
}

export interface DnsLookupResult {
  name: string;
  type: "A" | "AAAA" | "PTR";
  answers: string[];
}
export * from "./custom.js";
