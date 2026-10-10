// Proxmox VE and Proxmox Backup Server results as health and inventory.
import { describe, expect, it } from "vitest";
import { parseIntegrationConfig } from "./integrations/config.js";
import { backupHealth, PROXMOX, PROXMOX_BACKUP, proxmoxHealth, proxmoxInventory } from "./integrations/proxmox.js";

const config = parseIntegrationConfig(PROXMOX, { host: "10.0.0.10" });

describe("Proxmox VE", () => {
  it("watches nodes, storage against the thresholds, and only guests set to start at boot", () => {
    const out = proxmoxHealth(
      {
        nodes: [{ node: "pve1", status: "online", cpuPercent: 12.5, memoryPercent: 25, diskPercent: 10 }, { node: "pve2", status: "offline" }],
        storage: [
          { storage: "local-zfs", node: "pve1", status: "available", usedPercent: 92 },
          { storage: "nas", node: "pve1", status: "unavailable" },
        ],
        guests: [
          { id: 100, name: "homeassistant", kind: "vm", node: "pve1", status: "running", onboot: true },
          { id: 101, name: "pihole", kind: "container", node: "pve2", status: "stopped", onboot: true },
          { id: 102, name: "win11", kind: "vm", node: "pve1", status: "stopped", onboot: false },
        ],
      },
      config,
    );
    expect(out.alerts!.map((a) => [a.key, a.status])).toEqual([
      ["node:pve1", "up"],
      ["node:pve2", "down"],
      ["storage:pve1/local-zfs", "degraded"],
      ["storage:pve1/nas", "down"],
      ["guest:100", "up"],
      ["guest:101", "down"],
    ]);
    expect(out.alerts![0]).toMatchObject({ value: 12.5, values: { cpuPercent: 12.5, memoryPercent: 25, diskPercent: 10 } });
    expect(out.alerts![5]).toMatchObject({ name: "pihole (container 101)", message: "stopped on pve2, but set to start at boot" });
    expect(out.summary).toBe("1 of 2 node(s) online, 1 of 3 guest(s) running, storage up to 92% used");
    // Raising the threshold moves storage back to up.
    const relaxed = proxmoxHealth({ nodes: [], guests: [], storage: [{ storage: "local-zfs", node: "pve1", status: "available", usedPercent: 92 }] }, { ...config, options: { storageWarn: 95 } });
    expect(relaxed.alerts![0]!.status).toBe("up");
  });

  it("puts nodes, VMs and containers in the inventory, each guest under its node", () => {
    const out = proxmoxInventory({
      nodes: [{ node: "pve1", status: "online", ip: "10.0.0.10" }],
      guests: [{ id: 100, name: "homeassistant", kind: "vm", node: "pve1", status: "running", macs: ["bc:24:11:00:01:00"], ips: ["10.0.0.20"], onboot: true, ostype: "l26" }],
    });
    expect(out.inventory).toEqual([
      { externalId: "node/pve1", name: "pve1", kind: "server", vendor: "Proxmox", os: "Proxmox VE", ips: ["10.0.0.10"], macs: [], details: { node: "pve1" } },
      {
        externalId: "qemu/100",
        name: "homeassistant",
        kind: "vm",
        os: "Linux",
        ips: ["10.0.0.20"],
        macs: ["bc:24:11:00:01:00"],
        parentExternalId: "node/pve1",
        createWithoutIp: true,
        details: { vmid: 100, node: "pve1", status: "running", startsAtBoot: true },
      },
    ]);
  });
});

describe("Proxmox Backup Server", () => {
  it("flags guests not backed up within the limit, and full datastores", () => {
    const now = new Date("2030-01-10T12:00:00Z");
    const out = backupHealth(
      {
        datastores: [{ store: "main", usedPercent: 88, totalGb: 2000 }],
        groups: [
          { store: "main", type: "vm", id: "100", comment: "homeassistant", lastBackup: "2030-01-10T02:00:00Z", count: 14 },
          { store: "main", type: "ct", id: "101", lastBackup: "2030-01-06T02:00:00Z", count: 3 },
          { store: "main", type: "vm", id: "102" },
        ],
      },
      parseIntegrationConfig(PROXMOX_BACKUP, {}),
      now,
    );
    expect(out.alerts!.map((a) => [a.name, a.status, a.message])).toEqual([
      ["Backup datastore main", "degraded", "88% of 2000 GB used"],
      ["Backups of homeassistant (vm 100)", "up", "Last backup 10 hours ago, 14 kept"],
      ["Backups of ct 101", "down", "Last backup 4 days ago, 3 kept"],
      ["Backups of vm 102", "down", "Never backed up"],
    ]);
    expect(out.summary).toBe("1 datastore(s), 3 guest(s) backed up, 2 overdue");
  });
});
