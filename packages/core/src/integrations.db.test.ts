// The integration framework: inventory matching, health on monitors (with readings), and recording each run.
import { assets, monitors, networks, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIntegrationConfig, integrationArgs } from "./integrations/config.js";
import { applyIntegrationInventory } from "./integrations/inventory.js";
import { applyFeatureRun, featureDue } from "./integrations/run.js";
import type { IntegrationDef } from "./integrations/types.js";
import { loadModule } from "./services/modules.js";
import { bootstrapOrg } from "./store/bootstrap.js";

const def: IntegrationDef = {
  key: "testlab",
  name: "Test Lab",
  description: "A stand-in integration.",
  plan: "free",
  connection: { defaultPort: 8006, hint: "" },
  credential: { secretName: "testlab-token", type: "api_token", arg: "token", label: "API token", hint: "", tools: ["testlab_status"] },
  test: { op: "status", describe: () => "ok" },
  ops: { status: { tool: "testlab_status" } },
  features: [
    {
      key: "health",
      label: "Health checks",
      description: "",
      everyMs: 5 * 60_000,
      op: "status",
      apply: (r) => ({ alerts: [{ key: "node", name: "Node pve1", status: "up", message: "fine", value: 12.5, values: { cpuPercent: 12.5, memPercent: 40 }, unit: "%" }], summary: String(r) }),
    },
  ],
  agentTools: [],
};

describe("integration config", () => {
  it("falls back to defaults, and builds connection arguments with a secret handle", () => {
    const c = parseIntegrationConfig(def, { host: "not an ip", port: "x", features: { health: true, bogus: true } });
    expect(c).toMatchObject({ host: undefined, port: 8006, features: { health: true }, priority: "P3" });
    expect(c.features).not.toHaveProperty("bogus");
    expect(() => integrationArgs(def, c)).toThrow(/address first/);
    expect(integrationArgs(def, { ...c, host: "192.168.1.5" })).toEqual({ target: "192.168.1.5", port: 8006, verifyTls: false, token: "secret:testlab-token" });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("integrations (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_integrations"));
    orgId = (await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" })).org.id;
    await db.insert(networks).values({ orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" });
    await db.insert(assets).values([
      { orgId, name: "192.168.1.20", primaryIp: "192.168.1.20", source: "sensor" },
      { orgId, name: "Kept name", primaryMac: "aa:bb:cc:00:00:01", source: "user", locked: true },
    ]);
  });
  afterAll(() => close?.());

  it("matches by MAC and IP, adds VMs without addresses, links them to their node, and marks gone ones missing", async () => {
    const items = [
      { externalId: "node/pve1", name: "pve1", kind: "server", ips: ["192.168.1.20"], macs: [] },
      { externalId: "qemu/101", name: "nextcloud", kind: "vm", ips: [], macs: [], parentExternalId: "node/pve1", createWithoutIp: true, details: { vmid: 101 } },
      { externalId: "qemu/102", name: "locked one", kind: "vm", ips: [], macs: ["AA:BB:CC:00:00:01"], parentExternalId: "node/pve1" },
      { externalId: "qemu/103", name: "elsewhere", ips: ["10.9.9.9"], macs: [] },
    ];
    expect(await applyIntegrationInventory(db, orgId, "testlab", items)).toEqual({ matched: 2, created: 1, locked: 1, skipped: 1, missing: 0 });
    const [node] = await db.select().from(assets).where(eq(assets.primaryIp, "192.168.1.20"));
    expect(node).toMatchObject({ name: "pve1", kind: "server" });
    const [vm] = await db.select().from(assets).where(eq(assets.name, "nextcloud"));
    expect(vm).toMatchObject({ kind: "vm", source: "integration:testlab", primaryIp: null });
    expect(vm!.attributes).toMatchObject({ parentAssetId: node!.id, testlab: { externalId: "qemu/101", vmid: 101 } });
    const [locked] = await db.select().from(assets).where(eq(assets.primaryMac, "aa:bb:cc:00:00:01"));
    expect(locked).toMatchObject({ name: "Kept name", attributes: {} });

    // The next sync finds the VM by its id (renamed in Proxmox), and the node is gone from the answer.
    expect(await applyIntegrationInventory(db, orgId, "testlab", [{ ...items[1]!, name: "cloud" }])).toMatchObject({ matched: 1, created: 0 });
    const [again] = await db.select().from(assets).where(eq(assets.id, vm!.id));
    expect(again!.name).toBe("nextcloud"); // a name it chose earlier isn't "automatic"
    // A VM deleted in Proxmox: an asset this integration added goes missing.
    expect(await applyIntegrationInventory(db, orgId, "testlab", [items[0]!])).toMatchObject({ missing: 1 });
    expect((await db.select().from(assets).where(eq(assets.id, vm!.id)))[0]!.status).toBe("missing");
  });

  it("records health with readings on the integration's monitors, and notes each run", async () => {
    const c = parseIntegrationConfig(def, { host: "192.168.1.20", features: { health: true } });
    const now = new Date();
    const run = await applyFeatureRun(db, orgId, def, c, {}, def.features[0]!, { ok: true, result: "3 nodes" }, now);
    expect(run).toEqual({ ok: true, summary: "3 nodes" });
    const [m] = await db.select().from(monitors).where(eq(monitors.externalKey, "testlab:node"));
    expect(m).toMatchObject({ name: "Node pve1", kind: "external", state: "up" });
    expect(m!.lastResult).toMatchObject({ value: 12.5, values: { cpuPercent: 12.5, memPercent: 40 }, unit: "%" });
    const state = (await loadModule(db, orgId, "testlab")).state as { sourceId?: string; runs?: Record<string, { ok: boolean }> };
    expect(state.sourceId).toBe(m!.sourceId);
    expect(featureDue(state, def.features[0]!, now)).toBe(false);
    expect(featureDue(state, def.features[0]!, new Date(now.getTime() + 6 * 60_000))).toBe(true);

    // Unreachable: the health feature says so on a monitor of its own.
    const failed = await applyFeatureRun(db, orgId, def, c, state, def.features[0]!, { ok: false, error: "Could not reach Test Lab" }, now);
    expect(failed).toEqual({ ok: false, summary: "Could not reach Test Lab" });
    const [down] = await db.select().from(monitors).where(eq(monitors.externalKey, "testlab:reachable"));
    expect(down).toMatchObject({ name: "Test Lab", state: "down" });
  });
});
