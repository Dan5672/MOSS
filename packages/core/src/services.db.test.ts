import { assets, assetServices, networks, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAsset, AssetLockedError, ingestDiscoveredHosts, searchAssets, setAssetLocked, updateAsset } from "./services/assets.js";
import { listNetworks, reportNetwork, setNetworkStatus } from "./services/networks.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe.skipIf(!TEST_DATABASE_URL)("asset and network services (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let userId: string;
  const agent = { type: "agent" as const, id: "00000000-0000-0000-0000-0000000000aa" };

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_services"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    userId = boot.owner.id;
    await setNetworkStatus(db, orgId, { cidr: "192.168.1.0/24", status: "allowed", name: "LAN" }, userId);
  });
  afterAll(() => close?.());

  it("creates assets with services and links them to their network", async () => {
    const res = await ingestDiscoveredHosts(
      db,
      orgId,
      [
        {
          ip: "192.168.1.10",
          mac: "AA:BB:CC:00:00:10",
          vendor: "Synology",
          hostnames: ["nas.lan"],
          ports: [
            { protocol: "tcp", port: 5000, state: "open", service: "http" },
            { protocol: "tcp", port: 22, state: "closed" },
          ],
        },
      ],
      "agent:x",
    );
    expect(res.created).toHaveLength(1);
    const [nas] = await db.select().from(assets).where(eq(assets.id, res.created[0]!));
    expect(nas).toMatchObject({ name: "nas.lan", primaryMac: "aa:bb:cc:00:00:10", vendor: "Synology", primaryIp: "192.168.1.10" });
    const [lan] = await db.select().from(networks).where(eq(networks.cidr, "192.168.1.0/24"));
    expect(nas!.networkId).toBe(lan!.id);
    const services = await db.select().from(assetServices).where(eq(assetServices.assetId, nas!.id));
    expect(services.map((s) => s.port)).toEqual([5000]); // closed ports are not services
  });

  it("matches by MAC across IP changes, and merges hostnames", async () => {
    const res = await ingestDiscoveredHosts(db, orgId, [{ ip: "192.168.1.11", mac: "aa:bb:cc:00:00:10", hostnames: ["diskstation"] }], "agent:x");
    expect(res).toMatchObject({ created: [], updated: [expect.any(String)] });
    const [nas] = await db.select().from(assets).where(eq(assets.id, res.updated[0]!));
    expect(nas).toMatchObject({ primaryIp: "192.168.1.11", hostnames: ["nas.lan", "diskstation"] });
  });

  it("treats a different MAC on a known IP as a new device", async () => {
    const res = await ingestDiscoveredHosts(db, orgId, [{ ip: "192.168.1.11", mac: "11:22:33:44:55:66" }], "agent:x");
    expect(res.created).toHaveLength(1);
  });

  it("matches MAC-less hosts by IP (e.g. routed scans)", async () => {
    const res = await ingestDiscoveredHosts(db, orgId, [{ ip: "192.168.1.11", ports: [{ protocol: "tcp", port: 443, state: "open" }] }], "agent:x");
    expect(res).toMatchObject({ created: [], updated: [expect.any(String)] });
  });

  it("stops agents from editing locked assets, but keeps last-seen fresh", async () => {
    const [asset] = await searchAssets(db, orgId, { query: "nas.lan" });
    await updateAsset(db, orgId, asset!.id, { kind: "nas", attributes: { model: "DS920+" } }, agent);
    await setAssetLocked(db, orgId, asset!.id, true, userId);
    await expect(updateAsset(db, orgId, asset!.id, { name: "renamed" }, agent)).rejects.toBeInstanceOf(AssetLockedError);
    await updateAsset(db, orgId, asset!.id, { notes: "Owner's NAS" }, { type: "user", id: userId });

    await ingestDiscoveredHosts(db, orgId, [{ ip: "192.168.1.99", mac: "aa:bb:cc:00:00:10", hostnames: ["evil-rename"] }], "agent:x");
    const [after] = await db.select().from(assets).where(eq(assets.id, asset!.id));
    expect(after).toMatchObject({ kind: "nas", notes: "Owner's NAS", primaryIp: "192.168.1.11", attributes: { model: "DS920+" } });
    expect(after!.hostnames).not.toContain("evil-rename");
  });

  it("searches by text, IP range and kind", async () => {
    expect((await searchAssets(db, orgId, { query: "synology" })).map((a) => a.name)).toEqual(["nas.lan"]);
    expect(await searchAssets(db, orgId, { ip: "192.168.1.0/24" })).toHaveLength(2);
    expect(await searchAssets(db, orgId, { kind: "nas" })).toHaveLength(1);
    expect(await searchAssets(db, orgId, { query: "%" })).toHaveLength(0); // wildcards are escaped
    const [withServices] = await searchAssets(db, orgId, { query: "nas.lan" });
    expect(withServices!.services.map((s) => s.port)).toEqual([5000]);
  });

  it("adds assets manually", async () => {
    const a = await addAsset(db, orgId, { name: "Printer", kind: "printer", ip: "192.168.1.50" }, agent);
    expect(a).toMatchObject({ source: `agent:${agent.id}`, confidence: 50 });
    await expect(addAsset(db, orgId, { name: "x", ip: "not-ip" }, agent)).rejects.toThrow();
  });

  it("lets agents report networks only as unknown, never upgrading a known one", async () => {
    const reported = await reportNetwork(db, orgId, { cidr: "10.20.0.77/16", name: "IoT VLAN" }, agent);
    expect(reported).toMatchObject({ created: true, cidr: "10.20.0.0/16" });
    expect(await reportNetwork(db, orgId, { cidr: "192.168.1.0/24" }, agent)).toMatchObject({ created: false });

    const all = await listNetworks(db, orgId);
    expect(all.map((n) => [n.cidr, n.status])).toEqual([
      ["10.20.0.0/16", "unknown"],
      ["192.168.1.0/24", "allowed"],
    ]);
    await setNetworkStatus(db, orgId, { cidr: "10.20.0.0/16", status: "off_limits" }, userId);
    expect((await listNetworks(db, orgId))[0]!.status).toBe("off_limits");
  });
});
