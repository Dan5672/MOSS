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
    dnsServers: z.array(z.string().max(45).regex(/^[0-9A-Fa-f:.]+$/)).max(2).optional().describe("Leave out: MOSS fills in the network's DNS server, for device names"),
  }),
);

export const arpScan = tool(
  { name: "arp_scan", class: "read", targetArgs: ["targets"] },
  "Discover devices on a directly attached IPv4 subnet using ARP. Returns IP, MAC and NIC vendor. " +
    "Only works for subnets the toolbox is directly connected to.",
  z.object({ targets: z.array(ipOrCidr).min(1).max(8) }),
);

export const ping = tool(
  { name: "ping", class: "read", targetArgs: ["target"], publicTargets: true },
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
  { name: "tcp_connect", class: "read", targetArgs: ["target"], publicTargets: true },
  "Open a TCP connection to one port on a host and report whether it was accepted and how long it took. Sends no data.",
  z.object({ target: hostIp, port, timeoutMs }),
);

export const httpProbe = tool(
  { name: "http_probe", class: "read", targetArgs: ["target"], publicTargets: true },
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
  { name: "tls_inspect", class: "read", targetArgs: ["target"], publicTargets: true },
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

/**
 * How a UniFi tool signs in: an API key (UniFi Network 9.0 and later), or a local account's username and
 * password. Give one or the other; the toolbox refuses a call with neither or both.
 */
const unifiAuth = {
  apiKey: secretHandle.optional().describe("An API key stored as a secret. Or use username and password instead."),
  username: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.@+-]+$/)
    .optional()
    .describe("A local UniFi account (not a Ubiquiti cloud account with two-factor sign-in), used with password"),
  password: secretHandle.optional().describe("That account's password stored as a secret"),
};

export const unifiClients = tool(
  { name: "unifi_clients", class: "read", targetArgs: ["controller"], secretArgs: ["apiKey", "password"] },
  "List the clients a UniFi console knows about: IP, MAC, name, wired or Wi-Fi, and when each connected. The best way to " +
    "name devices and learn their MACs. Signs in with an API key, or a local account's username and password, stored as " +
    "secrets. Results are added to the inventory.",
  z.object({
    controller: hostIp.describe("The UniFi console or gateway, e.g. 10.0.0.1"),
    ...unifiAuth,
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

const haConnection = {
  ...apiCommon,
  token: secretHandle.describe("A Home Assistant long-lived access token stored as a secret"),
  port: port.default(8123),
  scheme: z.enum(["http", "https"]).default("http"),
};

export const homeassistantHealth = tool(
  { name: "homeassistant_health", class: "read", targetArgs: ["target"], secretArgs: ["token"] },
  "Check Home Assistant's own health: its version, integrations that failed to load, pending updates, and entities that are unavailable.",
  z.object(haConnection),
);

export const homeassistantLogs = tool(
  { name: "homeassistant_logs", class: "read", targetArgs: ["target"], secretArgs: ["token"] },
  "Summarise Home Assistant's error log: counts by level, the most repeated problems grouped by integration (with first and last " +
    "time seen), and the latest errors. Use it to spot new, growing or unusual problems.",
  z.object({
    ...haConnection,
    sinceHours: z.number().int().min(1).max(168).default(24).describe("Only entries from the last this many hours"),
    minLevel: z.enum(["WARNING", "ERROR"]).default("WARNING"),
  }),
);

export const homeassistantDevices = tool(
  { name: "homeassistant_devices", class: "read", targetArgs: ["target"], secretArgs: ["token"] },
  "List the devices Home Assistant knows: name, room (area), manufacturer and model, and any MAC and IP addresses it has for them.",
  z.object({ ...haConnection, limit: z.number().int().min(1).max(1000).default(500) }),
);

// --- Vulnerability scanning (read-only probes; the gate scopes targets like any other tool) ------------
const scanPorts = z.array(port).min(1).max(20);

export const vulnScan = tool(
  { name: "vuln_scan", class: "read", targetArgs: ["target"] },
  "Scan one host for known weaknesses with nmap. Profile 'safe': nmap's safe and vuln scripts, with anything intrusive, " +
    "denial-of-service, brute-force, exploit, fuzzing or third-party excluded (service versions, TLS ciphers, known " +
    "misconfigurations). Profile 'cve': look up known CVEs for each service version (sends service names and versions to " +
    "vulners.com, so the owner must allow it in Settings). Ports default to the 100 most common.",
  z.object({
    target: hostIp,
    profile: z.enum(["safe", "cve"]).default("safe"),
    ports: scanPorts.optional(),
  }),
);

export const nucleiScan = tool(
  { name: "nuclei_scan", class: "read", targetArgs: ["target"] },
  "Check one host with Nuclei's community templates for known vulnerabilities, misconfigurations, exposed admin panels " +
    "and default pages. Only non-intrusive templates run (no denial-of-service, fuzzing, brute force or default-login " +
    "attempts), rate-limited, with no out-of-band callbacks. Ports default to 80 and 443.",
  z.object({
    target: hostIp,
    ports: scanPorts.max(10).optional(),
    severity: z.array(z.enum(["info", "low", "medium", "high", "critical"])).min(1).max(5).default(["medium", "high", "critical"]),
  }),
);

export const tlsAudit = tool(
  { name: "tls_audit", class: "read", targetArgs: ["target"] },
  "Audit a TLS service in depth with testssl.sh: protocol versions, weak ciphers, certificate problems and known TLS " +
    "vulnerabilities (Heartbleed, ROBOT and the like). Takes a minute or two.",
  z.object({
    target: hostIp,
    port: port.default(443),
    hostname: hostname.optional().describe("The name to present (SNI), if the service hosts several"),
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

// --- Write tools ------------------------------------------------------------------------------
// Everything below changes something, so the gate only runs a call that exactly matches a step of an
// approved change request, inside its window. Arguments are strict so the plan a human approves is the
// exact request that runs.
const unitName = z.string().regex(/^[A-Za-z0-9@._:-]{1,100}$/, "A systemd unit name, e.g. nginx or nginx.service");
const containerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "A Docker container name");
const dnsName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^([A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/, "A domain name, e.g. ads.example.com");
const ipv4 = z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "An IPv4 address");
const macAddress = z
  .string()
  .regex(/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/, "A MAC address")
  .transform((m) => m.toLowerCase().replace(/-/g, ":"));
const haApi = {
  ...apiCommon,
  token: secretHandle.describe("A Home Assistant long-lived access token stored as a secret"),
  port: port.default(8123),
  scheme: z.enum(["http", "https"]).default("http"),
};
const piholeApi = {
  ...apiCommon,
  password: secretHandle.describe("The Pi-hole web or app password stored as a secret"),
  port: port.default(80),
  scheme: z.enum(["http", "https"]).default("http"),
};
const adguardApi = {
  ...apiCommon,
  user: z.string().min(1).max(64).describe("The AdGuard Home user name"),
  password: secretHandle.describe("That user's password stored as a secret"),
  port: port.default(80),
  scheme: z.enum(["http", "https"]).default("http"),
};
const unifiApi = {
  controller: hostIp.describe("The UniFi console or gateway"),
  ...unifiAuth,
  port: port.default(443),
  site: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .default("default"),
  timeoutMs,
};

export const serviceRestart = tool(
  { name: "service_restart", class: "write", targetArgs: ["target"], secretArgs: ["key"] },
  "Restart, start or stop a systemd service over SSH (sudo -n systemctl), then report its new state. Needs passwordless sudo " +
    "for systemctl on that server. Only runs as part of an approved change.",
  z.object({ ...sshArgs, service: unitName, action: z.enum(["restart", "start", "stop"]).default("restart") }),
);

export const containerRestart = tool(
  { name: "container_restart", class: "write", targetArgs: ["target"], secretArgs: ["key"] },
  "Restart, start or stop a Docker container over SSH, then report its new state. Only runs as part of an approved change.",
  z.object({ ...sshArgs, container: containerName, action: z.enum(["restart", "start", "stop"]).default("restart") }),
);

export const hostReboot = tool(
  { name: "host_reboot", class: "write", targetArgs: ["target"], secretArgs: ["key"] },
  "Schedule a reboot of a Linux server over SSH (sudo -n shutdown -r), a minute or more ahead so the session ends cleanly. " +
    "Needs passwordless sudo for shutdown. Only runs as part of an approved change.",
  z.object({ ...sshArgs, delayMinutes: z.number().int().min(1).max(60).default(1) }),
);

export const homeassistantSwitch = tool(
  { name: "homeassistant_switch", class: "write", targetArgs: ["target"], secretArgs: ["token"] },
  "Turn a Home Assistant switch, light, fan or input_boolean on or off (or toggle it), then report its new state. Only runs " +
    "as part of an approved change.",
  z.object({
    ...haApi,
    entity: z
      .string()
      .regex(/^(switch|light|fan|input_boolean)\.[a-z0-9_]{1,100}$/, "A switch, light, fan or input_boolean entity id")
      .describe("e.g. switch.modem_plug"),
    action: z.enum(["turn_on", "turn_off", "toggle"]),
  }),
);

export const homeassistantPowerCycle = tool(
  { name: "homeassistant_power_cycle", class: "write", targetArgs: ["target"], secretArgs: ["token"] },
  "Power-cycle a device on a Home Assistant smart plug: turn the switch off, wait, turn it back on, and report each state. " +
    "For a hung modem or access point. Only runs as part of an approved change.",
  z.object({
    ...haApi,
    entity: z.string().regex(/^switch\.[a-z0-9_]{1,100}$/, "A switch entity id, e.g. switch.modem_plug"),
    offSeconds: z.number().int().min(5).max(120).default(15),
  }),
);

export const piholeDomainRule = tool(
  { name: "pihole_domain_rule", class: "write", targetArgs: ["target"], secretArgs: ["password"] },
  "Add or remove an exact domain on Pi-hole's (v6) deny or allow list. Only runs as part of an approved change.",
  z.object({ ...piholeApi, domain: dnsName, list: z.enum(["deny", "allow"]), action: z.enum(["add", "remove"]) }),
);

export const piholeLocalDns = tool(
  { name: "pihole_local_dns", class: "write", targetArgs: ["target"], secretArgs: ["password"] },
  "Add or remove a local DNS record on Pi-hole (v6), e.g. nas.lan -> 10.0.0.12. Only runs as part of an approved change.",
  z.object({ ...piholeApi, hostname: dnsName, ip: ipv4, action: z.enum(["add", "remove"]) }),
);

export const adguardRule = tool(
  { name: "adguard_rule", class: "write", targetArgs: ["target"], secretArgs: ["password"] },
  "Block or unblock a domain with an AdGuard Home custom filtering rule, or remove MOSS's rule for it. Only runs as part " +
    "of an approved change.",
  z.object({ ...adguardApi, domain: dnsName, action: z.enum(["block", "unblock", "remove"]) }),
);

export const adguardRewrite = tool(
  { name: "adguard_rewrite", class: "write", targetArgs: ["target"], secretArgs: ["password"] },
  "Add or remove an AdGuard Home DNS rewrite (a local DNS record), e.g. nas.lan -> 10.0.0.12. Only runs as part of an " +
    "approved change.",
  z.object({ ...adguardApi, domain: dnsName, answer: ipv4, action: z.enum(["add", "remove"]) }),
);

export const unifiClientBlock = tool(
  { name: "unifi_client_block", class: "write", targetArgs: ["controller"], secretArgs: ["apiKey", "password"] },
  "Block or unblock a client (by MAC) on a UniFi network, cutting it off from Wi-Fi and wired ports. Only runs as part of " +
    "an approved change.",
  z.object({ ...unifiApi, mac: macAddress, action: z.enum(["block", "unblock"]) }),
);

export const unifiDhcpReservation = tool(
  { name: "unifi_dhcp_reservation", class: "write", targetArgs: ["controller"], secretArgs: ["apiKey", "password"] },
  "Give a UniFi client (by MAC) a fixed DHCP address, or clear its reservation. The client must be known to the console. " +
    "Only runs as part of an approved change.",
  z.object({ ...unifiApi, mac: macAddress, ip: ipv4.optional().describe("The address to reserve; omit to clear the reservation") }),
);

export const unifiWlanEnable = tool(
  { name: "unifi_wlan_enable", class: "write", targetArgs: ["controller"], secretArgs: ["apiKey", "password"] },
  "Turn a UniFi Wi-Fi network (by SSID) on or off, e.g. the guest network. Only runs as part of an approved change.",
  z.object({ ...unifiApi, ssid: z.string().min(1).max(32), enabled: z.boolean() }),
);

export const unifiFirewall = tool(
  { name: "unifi_firewall", class: "read", targetArgs: ["controller"], secretArgs: ["apiKey", "password"] },
  "Read a UniFi gateway's security setup (read-only): its networks and VLANs, firewall rules (or zone-based firewall " +
    "policies on newer versions) with what they allow or block between which networks and ports, and port forwards. " +
    "Signs in with an API key, or a local account's username and password.",
  z.object({ ...unifiApi, includeBuiltIn: z.boolean().default(false).describe("Also list UniFi's own built-in policies") }),
);

// --- Config backups -----------------------------------------------------------------------------
// Copies a device's configuration into MOSS. The gate encrypts and stores the file and hands the agent
// only its id, size and hash: configs often contain passwords, so the content never reaches a model.
/** Config locations a backup may read from; never "..". */
export const BACKUP_PATH = /^\/(etc|opt|srv|usr\/local\/etc|var\/lib|home\/[A-Za-z0-9._-]+)\/[A-Za-z0-9._/@+-]{1,400}$/;

export const configBackup = tool(
  { name: "config_backup", class: "read", targetArgs: ["target"], secretArgs: ["key", "password"] },
  "Back up a device's configuration into MOSS, encrypted. Sources: 'ssh_file' copies one config file over SSH (under /etc, " +
    "/opt, /srv, /usr/local/etc, /var/lib or a home directory; at most 512 KB); 'pihole' downloads a Pi-hole (v6) Teleporter " +
    "export. You get back the backup's id, size and SHA-256, never its contents. Take one before changing a device's config.",
  z
    .object({
      target: hostIp,
      source: z.enum(["ssh_file", "pihole"]),
      // ssh_file
      user: sshArgs.user.optional(),
      key: secretHandle.optional().describe("ssh_file: an SSH private key stored as a secret"),
      path: z
        .string()
        .max(420)
        .regex(BACKUP_PATH, "A config file path under /etc, /opt, /srv, /usr/local/etc, /var/lib or /home/<user>")
        .refine((p) => !p.split("/").some((s) => s === ".." || s === "."), "The path may not contain . or .. segments")
        .optional(),
      hostKeySha256: sshArgs.hostKeySha256,
      // pihole
      password: secretHandle.optional().describe("pihole: the Pi-hole web or app password stored as a secret"),
      scheme: z.enum(["http", "https"]).optional(),
      verifyTls: z.boolean().default(false),
      port: port.optional().describe("Default 22 for ssh_file, 80 for pihole"),
      timeoutMs,
    })
    .superRefine((a, ctx) => {
      if (a.source === "ssh_file" && (!a.user || !a.key || !a.path)) ctx.addIssue({ code: "custom", message: "ssh_file needs user, key and path" });
      if (a.source === "pihole" && !a.password) ctx.addIssue({ code: "custom", message: "pihole needs password" });
    }),
);

export interface ConfigBackupFile {
  source: "ssh_file" | "pihole";
  target: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** Present only between the toolbox and the gate; the gate stores it and removes it. */
  contentBase64?: string;
}

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
    homeassistantHealth,
    homeassistantLogs,
    homeassistantDevices,
    piholeSummary,
    adguardStats,
    serviceRestart,
    containerRestart,
    hostReboot,
    homeassistantSwitch,
    homeassistantPowerCycle,
    piholeDomainRule,
    piholeLocalDns,
    adguardRule,
    adguardRewrite,
    unifiClientBlock,
    unifiDhcpReservation,
    unifiWlanEnable,
    unifiFirewall,
    vulnScan,
    nucleiScan,
    tlsAudit,
    configBackup,
  ].map((t) => [t.manifest.name, t as unknown as ToolDefinition]),
);

// --- System tools ---------------------------------------------------------------------------
// Called only by MOSS itself (through the gate, for an enabled module), never by an agent: they are not
// in BUILT_IN_TOOLS, so the gate can't grant them, list them or run them for an agent.

/** Home Assistant's notify services, e.g. mobile_app_pixel_8. */
const notifyService = z.string().regex(/^[a-z0-9_]{1,64}$/, "A notify service name, e.g. mobile_app_pixel_8");

export const homeassistantNotify = tool(
  { name: "homeassistant_notify", class: "write", targetArgs: ["target"], secretArgs: ["token"] },
  "Send a notification through a Home Assistant notify service (for example the companion app on a phone).",
  z.object({
    ...haConnection,
    service: notifyService,
    title: z.string().min(1).max(120),
    message: z.string().min(1).max(1000),
    /** A path in MOSS the notification opens, e.g. /incidents/<id>. */
    url: z.string().max(500).regex(/^https?:\/\/[^\s]+$/).optional(),
  }),
);

/** MOSS's own entities in Home Assistant. Nothing else can be written. */
const mossEntity = z.string().regex(/^(sensor|binary_sensor)\.moss_[a-z0-9_]{1,40}$/,"Only sensor.moss_* or binary_sensor.moss_* entities");

export const homeassistantPublish = tool(
  { name: "homeassistant_publish", class: "write", targetArgs: ["target"], secretArgs: ["token"] },
  "Set the state of MOSS's own sensor.moss_* / binary_sensor.moss_* entities in Home Assistant.",
  z.object({
    ...haConnection,
    states: z
      .array(
        z.object({
          entity: mossEntity,
          state: z.string().max(64),
          attributes: z.record(z.string().regex(/^[a-z_]{1,32}$/), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
        }),
      )
      .min(1)
      .max(10),
  }),
);

export const SYSTEM_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map(
  [homeassistantNotify, homeassistantPublish].map((t) => [t.manifest.name, t as unknown as ToolDefinition]),
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
export * from "./home-assistant.js";
