// Groups for showing tools: in the secret scope picker, on Tool access and wherever a long list of tools
// would otherwise be one alphabetical wall. Order here is the order groups are shown in.

export const TOOL_GROUPS = [
  { key: "discovery", label: "Discovery", tools: ["nmap_scan", "arp_scan", "snmp_query", "traceroute", "name_lookup"] },
  { key: "probes", label: "Probes and monitoring", tools: ["ping", "dns_lookup", "tcp_connect", "http_probe", "tls_inspect"] },
  { key: "unifi", label: "UniFi", tools: ["unifi_clients", "unifi_firewall", "unifi_client_block", "unifi_dhcp_reservation", "unifi_wlan_enable"] },
  { key: "servers", label: "Servers (SSH)", tools: ["host_facts", "disk_usage", "service_status", "docker_ps", "service_restart", "container_restart", "host_reboot"] },
  { key: "homelab", label: "Home lab apps", tools: ["proxmox_status", "truenas_status", "synology_status"] },
  {
    key: "dns",
    label: "DNS filtering",
    tools: ["pihole_summary", "pihole_domain_rule", "pihole_local_dns", "adguard_stats", "adguard_rule", "adguard_rewrite"],
  },
  {
    key: "homeassistant",
    label: "Home Assistant",
    tools: ["homeassistant_states", "homeassistant_health", "homeassistant_logs", "homeassistant_devices", "homeassistant_switch", "homeassistant_power_cycle"],
  },
  { key: "power", label: "Power", tools: ["wake_on_lan"] },
  { key: "backups", label: "Backups", tools: ["config_backup"] },
  { key: "vuln", label: "Vulnerability scanning", tools: [] as string[] },
] as const;

export type ToolGroupKey = (typeof TOOL_GROUPS)[number]["key"] | "moss" | "custom" | "other";

const BY_TOOL = new Map<string, ToolGroupKey>(TOOL_GROUPS.flatMap((g) => g.tools.map((t) => [t, g.key] as const)));

export const GROUP_LABEL: Record<ToolGroupKey, string> = {
  ...(Object.fromEntries(TOOL_GROUPS.map((g) => [g.key, g.label])) as Record<(typeof TOOL_GROUPS)[number]["key"], string>),
  moss: "MOSS tools",
  custom: "Custom tools",
  other: "Other",
};

/** The group a tool is shown in. MOSS's own tools and custom tools have groups of their own. */
export function toolGroup(name: string, source: "network" | "moss" | "custom" = "network"): ToolGroupKey {
  if (source === "moss") return "moss";
  if (source === "custom") return "custom";
  return BY_TOOL.get(name) ?? "other";
}

/** Tools split into their groups, in display order, leaving out empty groups. */
export function groupTools<T>(items: T[], groupOf: (item: T) => ToolGroupKey): { key: ToolGroupKey; label: string; items: T[] }[] {
  const order: ToolGroupKey[] = [...TOOL_GROUPS.map((g) => g.key), "moss", "custom", "other"];
  return order.map((key) => ({ key, label: GROUP_LABEL[key], items: items.filter((i) => groupOf(i) === key) })).filter((g) => g.items.length > 0);
}
