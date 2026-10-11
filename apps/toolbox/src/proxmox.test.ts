// Proxmox VE and Proxmox Backup Server: inventory, backups, snapshots and power.
import type { RenderedRequest } from "@moss/tools";
import { describe, expect, it } from "vitest";
import type { RawRequest } from "./custom-http.js";
import { guestMacs } from "./homelab.js";
import { runTool } from "./runners.js";

function device(routes: Record<string, unknown | ((r: RenderedRequest) => unknown)>) {
  const seen: RenderedRequest[] = [];
  const send: RawRequest = async (r) => {
    seen.push(r);
    const route = routes[`${r.method} ${r.path}`];
    if (route === undefined) return { status: 404, body: Buffer.from("{}"), truncated: false };
    const json = typeof route === "function" ? (route as (r: RenderedRequest) => unknown)(r) : route;
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(json)), truncated: false };
  };
  return { send, seen };
}
const run = (tool: string, args: Record<string, unknown>, send: RawRequest) => runTool(tool, args, undefined, undefined, undefined, send);
const TOKEN = "moss@pve!ro=0b1c-uuid";

describe("Proxmox VE", () => {
  it("reads MACs from net lines of VMs and containers", () => {
    expect(guestMacs({ net0: "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1", net1: "e1000=BC:24:11:00:00:01,bridge=vmbr1", name: "x" })).toEqual(["bc:24:11:aa:bb:cc", "bc:24:11:00:00:01"]);
    expect(guestMacs({ net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:DE:AD:01,ip=dhcp,type=veth" })).toEqual(["bc:24:11:de:ad:01"]);
  });

  it("proxmox_status can say which guests start at boot", async () => {
    const { send } = device({
      "GET /api2/json/cluster/resources": { data: [{ type: "qemu", vmid: 100, name: "ha", node: "pve1", status: "stopped" }, { type: "qemu", vmid: 9000, name: "tmpl", node: "pve1", template: 1 }] },
      "GET /api2/json/nodes/pve1/qemu/100/config": { data: { onboot: 1 } },
    });
    const res = (await run("proxmox_status", { target: "10.0.0.10", token: TOKEN, bootFlags: true }, send)) as { guests: unknown[] };
    expect(res.guests).toEqual([expect.objectContaining({ id: 100, status: "stopped", onboot: true })]); // templates aren't guests
  });

  it("proxmox_inventory: nodes with addresses, guests with MACs and the addresses Proxmox knows", async () => {
    const { send } = device({
      "GET /api2/json/cluster/resources": {
        data: [
          { type: "node", node: "pve1", status: "online" },
          { type: "qemu", vmid: 100, name: "homeassistant", node: "pve1", status: "running" },
          { type: "lxc", vmid: 101, name: "pihole", node: "pve1", status: "running" },
          { type: "qemu", vmid: 102, name: "win11", node: "pve1", status: "stopped" },
        ],
      },
      "GET /api2/json/cluster/status": { data: [{ type: "cluster", name: "home" }, { type: "node", name: "pve1", ip: "10.0.0.10" }] },
      "GET /api2/json/nodes/pve1/qemu/100/config": { data: { onboot: 1, ostype: "l26", agent: "1", net0: "virtio=BC:24:11:00:01:00,bridge=vmbr0" } },
      "GET /api2/json/nodes/pve1/qemu/100/agent/network-get-interfaces": {
        data: { result: [{ name: "lo", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1" }] }, { name: "eth0", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "10.0.0.20" }, { "ip-address-type": "ipv6", "ip-address": "fe80::1" }] }] },
      },
      "GET /api2/json/nodes/pve1/lxc/101/config": { data: { onboot: 1, ostype: "debian", net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:01:01,ip=10.0.0.14/24" } },
      "GET /api2/json/nodes/pve1/lxc/101/interfaces": { data: [{ name: "lo", inet: "127.0.0.1/8" }, { name: "eth0", inet: "10.0.0.14/24" }] },
      "GET /api2/json/nodes/pve1/qemu/102/config": { data: { ostype: "win11", net0: "virtio=BC:24:11:00:01:02,bridge=vmbr0" } },
    });
    const res = await run("proxmox_inventory", { target: "10.0.0.10", token: TOKEN }, send);
    expect(res).toEqual({
      nodes: [{ node: "pve1", status: "online", ip: "10.0.0.10" }],
      guests: [
        { id: 100, name: "homeassistant", kind: "vm", node: "pve1", status: "running", macs: ["bc:24:11:00:01:00"], ips: ["10.0.0.20"], onboot: true, ostype: "l26" },
        { id: 101, name: "pihole", kind: "container", node: "pve1", status: "running", macs: ["bc:24:11:00:01:01"], ips: ["10.0.0.14"], onboot: true, ostype: "debian" },
        { id: 102, name: "win11", kind: "vm", node: "pve1", status: "stopped", macs: ["bc:24:11:00:01:02"], ips: [], onboot: false, ostype: "win11" },
      ],
    });
  });

  it("proxmox_snapshot and proxmox_guest_power start the task and wait for it", async () => {
    let polls = 0;
    const { send, seen } = device({
      "POST /api2/json/nodes/pve1/qemu/100/snapshot": { data: "UPID:pve1:snap" },
      "GET /api2/json/nodes/pve1/tasks/UPID%3Apve1%3Asnap/status": () => ({ data: ++polls < 2 ? { status: "running" } : { status: "stopped", exitstatus: "OK" } }),
      "POST /api2/json/nodes/pve1/lxc/101/status/shutdown": { data: "UPID:pve1:stop" },
      "GET /api2/json/nodes/pve1/tasks/UPID%3Apve1%3Astop/status": { data: { status: "stopped", exitstatus: "OK" } },
      "GET /api2/json/nodes/pve1/lxc/101/status/current": { data: { status: "stopped" } },
    });
    const snap = await run("proxmox_snapshot", { target: "10.0.0.10", token: TOKEN, node: "pve1", kind: "vm", vmid: 100, name: "before_update" }, send);
    expect(snap).toEqual({ node: "pve1", vmid: 100, snapshot: "before_update", done: true });
    expect(seen[0]!.body).toBe("snapname=before_update&description=Taken+by+an+approved+MOSS+change");
    expect(polls).toBe(2);
    const off = await run("proxmox_guest_power", { target: "10.0.0.10", token: TOKEN, node: "pve1", kind: "container", vmid: 101, action: "shutdown" }, send);
    expect(off).toEqual({ node: "pve1", vmid: 101, action: "shutdown", status: "stopped" });
  });

  it("reports a failed task", async () => {
    const { send } = device({
      "POST /api2/json/nodes/pve1/qemu/100/snapshot": { data: "UPID:x" },
      "GET /api2/json/nodes/pve1/tasks/UPID%3Ax/status": { data: { status: "stopped", exitstatus: "snapshot feature is not available" } },
    });
    await expect(run("proxmox_snapshot", { target: "10.0.0.10", token: TOKEN, node: "pve1", kind: "vm", vmid: 100, name: "s1" }, send)).rejects.toThrow(/Proxmox task failed: snapshot feature is not available/);
  });
});

describe("Proxmox Backup Server", () => {
  it("pbs_status: datastore use and the last backup of each guest, with either token form", async () => {
    const { send, seen } = device({
      "GET /api2/json/status/datastore-usage": { data: [{ store: "main", total: 2e12, used: 1.5e12, avail: 0.5e12 }] },
      "GET /api2/json/admin/datastore/main/groups": { data: [{ "backup-type": "vm", "backup-id": "100", "last-backup": 1791600000, "backup-count": 14, comment: "homeassistant" }] },
    });
    const res = await run("pbs_status", { target: "10.0.0.11", token: "moss@pbs!ro=abc-123" }, send);
    expect(seen[0]).toMatchObject({ port: 8007, headers: expect.objectContaining({ Authorization: "PBSAPIToken=moss@pbs!ro:abc-123" }) });
    expect(res).toEqual({
      datastores: [{ store: "main", usedPercent: 75, totalGb: 2000 }],
      groups: [{ store: "main", type: "vm", id: "100", comment: "homeassistant", lastBackup: "2026-10-10T02:40:00.000Z", count: 14 }],
    });
    await expect(run("pbs_status", { target: "10.0.0.11", token: "nonsense" }, send)).rejects.toThrow(/USER@REALM!TOKENID:SECRET/);
  });
});
