// Proxmox VE and Proxmox Backup Server. Proxmox: nodes, storage and the guests set to start at boot as monitors, and
// nodes, VMs and containers in the inventory (under their node). Backup Server: datastore use, and how long ago
// each guest was last backed up.
import type { ParsedAlert } from "../monitoring/webhooks.js";
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef, type InventoryItem } from "./types.js";

const HEALTH_EVERY = 5 * 60_000;
const INVENTORY_EVERY = 6 * 60 * 60_000;
const BACKUPS_EVERY = 30 * 60_000;
const defined = (o: Record<string, number | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "number")) as Record<string, number>;

interface PveStatus {
  nodes: { node?: string; status?: string; cpuPercent?: number; memoryPercent?: number; diskPercent?: number }[];
  guests: { id?: number; name?: string; kind?: string; node?: string; status?: string; onboot?: boolean }[];
  storage: { storage?: string; node?: string; status?: string; usedPercent?: number }[];
}

export function proxmoxHealth(r: PveStatus, c: IntegrationConfig): FeatureOutput {
  const warn = integrationOption(PROXMOX, c, "storageWarn");
  const crit = integrationOption(PROXMOX, c, "storageCritical");
  const alerts: ParsedAlert[] = [];
  for (const n of r.nodes) {
    const values = defined({ cpuPercent: n.cpuPercent, memoryPercent: n.memoryPercent, diskPercent: n.diskPercent });
    alerts.push({
      key: `node:${n.node}`,
      name: `Proxmox node ${n.node}`,
      status: n.status === "online" ? "up" : "down",
      message: n.status === "online" ? `Online, CPU ${values.cpuPercent ?? "?"}%, memory ${values.memoryPercent ?? "?"}%` : `Node is ${n.status ?? "unknown"}`,
      ...(values.cpuPercent !== undefined ? { value: values.cpuPercent, unit: "%" } : {}),
      values,
    });
  }
  for (const s of r.storage) {
    const used = s.usedPercent;
    const status = s.status !== "available" ? "down" : used !== undefined && used >= crit ? "down" : used !== undefined && used >= warn ? "degraded" : "up";
    alerts.push({
      key: `storage:${s.node}/${s.storage}`,
      name: `Proxmox storage ${s.storage} on ${s.node}`,
      status,
      message: s.status !== "available" ? `Storage is ${s.status ?? "unavailable"}` : `${used ?? "?"}% used`,
      ...(used !== undefined ? { value: used, unit: "%", values: { usedPercent: used } } : {}),
    });
  }
  // Only guests set to start at boot: a stopped one of those is a problem; others may be off on purpose.
  for (const g of r.guests.filter((x) => x.onboot)) {
    alerts.push({
      key: `guest:${g.id}`,
      name: `${g.name ?? `Guest ${g.id}`} (${g.kind === "vm" ? "VM" : "container"} ${g.id})`,
      status: g.status === "running" ? "up" : "down",
      message: g.status === "running" ? `Running on ${g.node}` : `${g.status ?? "Not running"} on ${g.node}, but set to start at boot`,
    });
  }
  const running = r.guests.filter((g) => g.status === "running").length;
  const online = r.nodes.filter((n) => n.status === "online").length;
  const fullest = Math.max(0, ...r.storage.map((s) => s.usedPercent ?? 0));
  return { alerts, summary: `${online} of ${r.nodes.length} node(s) online, ${running} of ${r.guests.length} guest(s) running, storage up to ${fullest}% used` };
}

const OS: Record<string, string> = { l26: "Linux", l24: "Linux", win11: "Windows 11", win10: "Windows 10", win8: "Windows 8", win7: "Windows 7", w2k8: "Windows Server 2008", solaris: "Solaris", other: "" };

interface PveInventory {
  nodes: { node?: string; status?: string; ip?: string }[];
  guests: { id?: number; name?: string; kind?: string; node?: string; status?: string; macs: string[]; ips: string[]; onboot?: boolean; ostype?: string }[];
}

export function proxmoxInventory(r: PveInventory): FeatureOutput {
  const inventory: InventoryItem[] = [
    ...r.nodes.filter((n) => n.node).map((n) => ({ externalId: `node/${n.node}`, name: n.node, kind: "server", vendor: "Proxmox", os: "Proxmox VE", ips: n.ip ? [n.ip] : [], macs: [], details: { node: n.node } })),
    ...r.guests
      .filter((g) => g.id)
      .map((g) => {
        const os = g.ostype ? (OS[g.ostype] ?? g.ostype.charAt(0).toUpperCase() + g.ostype.slice(1)) : undefined;
        return {
          externalId: `${g.kind === "vm" ? "qemu" : "lxc"}/${g.id}`,
          name: g.name,
          kind: g.kind === "vm" ? "vm" : "container",
          ...(os ? { os } : {}),
          ips: g.ips,
          macs: g.macs,
          parentExternalId: g.node ? `node/${g.node}` : undefined,
          createWithoutIp: true,
          details: { vmid: g.id, node: g.node, status: g.status, startsAtBoot: !!g.onboot },
        };
      }),
  ];
  return { inventory };
}

const proxmoxTools = ["proxmox_status", "proxmox_inventory", "proxmox_snapshot", "proxmox_guest_power"];

export const PROXMOX: IntegrationDef = {
  key: "proxmox",
  name: "Proxmox VE",
  description: "Watch your nodes, storage and the VMs and containers that should be running, and keep every guest in the inventory under its node.",
  plan: "free",
  connection: { defaultPort: 8006, hint: "Any node of the cluster (port 8006)." },
  credential: {
    secretName: "proxmox-token",
    type: "api_token",
    arg: "token",
    label: "API token",
    hint: "Proxmox: Datacenter > Permissions > API Tokens. Paste it as USER@REALM!TOKENID=SECRET. Read-only (the PVEAuditor role) is enough for these features; snapshots and power changes need VM.Snapshot and VM.PowerMgmt.",
    tools: proxmoxTools,
  },
  test: {
    op: "status",
    describe: (r) => {
      const s = r as PveStatus;
      return `Connected to Proxmox: ${s.nodes.length} node(s), ${s.guests.length} VM(s) and container(s), ${s.storage.length} storage pool(s).`;
    },
  },
  ops: { status: { tool: "proxmox_status", args: () => ({ bootFlags: true }) }, inventory: { tool: "proxmox_inventory" } },
  features: [
    {
      key: "health",
      label: "Health checks",
      description: "Every 5 minutes: nodes online, storage use, and VMs and containers set to start at boot actually running. Node CPU, memory and disk as readings.",
      everyMs: HEALTH_EVERY,
      op: "status",
      apply: (r, { config }) => proxmoxHealth(r as PveStatus, config),
    },
    {
      key: "inventory",
      label: "VMs and containers in the inventory",
      description: "Every 6 hours: nodes, VMs and containers as assets under their node, matched by MAC to devices MOSS already knows. Ones you delete in Proxmox are marked missing.",
      everyMs: INVENTORY_EVERY,
      op: "inventory",
      apply: (r) => proxmoxInventory(r as PveInventory),
    },
  ],
  options: [
    { key: "storageWarn", label: "Storage degraded at (% used)", default: 90, min: 50, max: 99 },
    { key: "storageCritical", label: "Storage down at (% used)", default: 98, min: 50, max: 100 },
  ],
  agentTools: proxmoxTools,
};

interface PbsStatus {
  datastores: { store?: string; usedPercent?: number; totalGb?: number }[];
  groups: { store: string; type?: string; id?: string; comment?: string; lastBackup?: string; count?: number }[];
}

const ago = (hours: number) => (hours < 1 ? "less than an hour ago" : hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`);

export function backupHealth(r: PbsStatus, c: IntegrationConfig, now: Date): FeatureOutput {
  const warn = integrationOption(PROXMOX_BACKUP, c, "storeWarn");
  const crit = integrationOption(PROXMOX_BACKUP, c, "storeCritical");
  const maxHours = integrationOption(PROXMOX_BACKUP, c, "maxAgeDays") * 24;
  const alerts: ParsedAlert[] = [];
  for (const d of r.datastores) {
    const used = d.usedPercent;
    alerts.push({
      key: `datastore:${d.store}`,
      name: `Backup datastore ${d.store}`,
      status: used === undefined ? "up" : used >= crit ? "down" : used >= warn ? "degraded" : "up",
      message: `${used ?? "?"}% of ${d.totalGb ?? "?"} GB used`,
      ...(used !== undefined ? { value: used, unit: "%", values: { usedPercent: used } } : {}),
    });
  }
  let stale = 0;
  for (const g of r.groups) {
    const hours = g.lastBackup ? (now.getTime() - Date.parse(g.lastBackup)) / 3_600_000 : Infinity;
    const late = hours > maxHours;
    if (late) stale++;
    alerts.push({
      key: `backup:${g.store}/${g.type}/${g.id}`,
      name: `Backups of ${g.comment ? `${g.comment} (${g.type} ${g.id})` : `${g.type} ${g.id}`}`,
      status: late ? "down" : "up",
      message: g.lastBackup ? `Last backup ${ago(hours)}, ${g.count ?? "?"} kept` : "Never backed up",
      ...(Number.isFinite(hours) ? { value: Math.round(hours * 10) / 10, unit: "h", values: { hoursSinceBackup: Math.round(hours * 10) / 10 } } : {}),
    });
  }
  return { alerts, summary: `${r.datastores.length} datastore(s), ${r.groups.length} guest(s) backed up${stale ? `, ${stale} overdue` : ", none overdue"}` };
}

export const PROXMOX_BACKUP: IntegrationDef = {
  key: "proxmox_backup",
  name: "Proxmox Backup Server",
  description: "Know when a VM or container hasn't been backed up for too long, and when a datastore is filling up.",
  plan: "free",
  connection: { defaultPort: 8007, hint: "Your Proxmox Backup Server (port 8007)." },
  credential: {
    secretName: "pbs-token",
    type: "api_token",
    arg: "token",
    label: "API token",
    hint: "Proxmox Backup Server: Configuration > Access Control > API Token. Paste it as USER@REALM!TOKENID:SECRET, and give it the DatastoreAudit role.",
    tools: ["pbs_status"],
  },
  test: {
    op: "status",
    describe: (r) => {
      const s = r as PbsStatus;
      return `Connected to Proxmox Backup Server: ${s.datastores.length} datastore(s), ${s.groups.length} guest(s) with backups.`;
    },
  },
  ops: { status: { tool: "pbs_status" } },
  features: [
    {
      key: "health",
      label: "Backup checks",
      description: "Every 30 minutes: how long ago each VM and container was last backed up, and how full each datastore is.",
      everyMs: BACKUPS_EVERY,
      op: "status",
      apply: (r, { config, now }) => backupHealth(r as PbsStatus, config, now),
    },
  ],
  options: [
    { key: "maxAgeDays", label: "A backup is overdue after (days)", default: 2, min: 1, max: 60 },
    { key: "storeWarn", label: "Datastore degraded at (% used)", default: 85, min: 50, max: 99 },
    { key: "storeCritical", label: "Datastore down at (% used)", default: 95, min: 50, max: 100 },
  ],
  agentTools: ["pbs_status"],
};
