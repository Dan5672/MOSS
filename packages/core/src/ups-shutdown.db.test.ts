// The UPS: readings as monitors, and the shutdown plan in both modes, cancelled when the power comes back.
import { agents, changeRequests, models, providers, standardChangeTemplates, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsHealth, type UpsReading } from "./integrations/nut.js";
import { approveUpsPlan, approvedInAdvance, getUpsPlan, saveUpsPlan, upsShutdownTick } from "./integrations/ups-shutdown.js";
import { saveModule, updateModuleState } from "./services/modules.js";
import { setSetting } from "./store/settings-store.js";
import { bootstrapOrg } from "./store/bootstrap.js";

const ups = (over: Partial<UpsReading> = {}): UpsReading => ({ name: "apc", status: "OL", onBattery: false, lowBattery: false, replaceBattery: false, charge: 100, runtimeSeconds: 3600, load: 20, ...over });

describe("UPS readings", () => {
  it("are monitors: on battery is down, a tired battery is degraded", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(upsHealth({ ups: [ups()] }, now).alerts![0]).toMatchObject({ key: "ups:apc", status: "up", value: 100, values: { charge: 100, runtimeMinutes: 60, load: 20 } });
    expect(upsHealth({ ups: [ups({ onBattery: true, charge: 64, runtimeSeconds: 780 })] }, now).alerts![0]).toMatchObject({ status: "down", message: "On battery: 64%, about 13 min left" });
    expect(upsHealth({ ups: [ups({ replaceBattery: true })] }, now).alerts![0]!.status).toBe("degraded");
    expect(upsHealth({ ups: [ups()] }, now).state).toEqual({ ups: { at: now.toISOString(), readings: [ups()] } });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("UPS shutdown plan (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  const steps = [
    { type: "ssh" as const, label: "Media server", target: "192.168.1.30", user: "moss", port: 22, secret: "media-key" },
    { type: "ssh" as const, label: "NAS", target: "192.168.1.10", user: "moss", port: 22, secret: "nas-key" },
  ];
  const readings = (r: UpsReading[], at = new Date()) => updateModuleState(db, orgId, "nut", { ups: { at: at.toISOString(), readings: r } });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_ups"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    agentId = (await db.insert(agents).values({ orgId, name: "Sam", title: "Sysadmin", systemPrompt: "x", modelId: model!.id }).returning())[0]!.id;
    await saveModule(db, orgId, "nut", { enabled: true, config: { host: "192.168.1.5" } }, { type: "user", id: ownerId });
  });
  afterAll(() => close?.());
  beforeEach(async () => {
    await db.delete(changeRequests);
    await setSetting(db, orgId, "ups.shutdown_run", {});
  });

  it("asks for approval when a UPS on battery runs low, once, and cancels it when the power comes back", async () => {
    await saveUpsPlan(db, orgId, { mode: "ask", agentId, runtimeMinutes: 10, steps });
    await readings([ups({ onBattery: true, charge: 80, runtimeSeconds: 1800 })]);
    expect(await upsShutdownTick(db, orgId)).toBeNull(); // still plenty left
    await readings([ups({ onBattery: true, charge: 30, runtimeSeconds: 540 })]);
    expect(await upsShutdownTick(db, orgId)).toBe("shutdown raised for approval");
    const [c] = await db.select().from(changeRequests);
    expect(c).toMatchObject({ status: "submitted", type: "normal", risk: "medium", requestedByAgentId: agentId, title: "Shut down for the power cut (UPS apc: 9 minutes left)" });
    expect(c!.plannedCalls.map((p) => [p.tool, p.args.target])).toEqual([
      ["host_shutdown", "192.168.1.30"],
      ["host_shutdown", "192.168.1.10"],
    ]);
    expect(await upsShutdownTick(db, orgId)).toBeNull(); // not raised twice
    await readings([ups()]);
    expect(await upsShutdownTick(db, orgId)).toBe("power back: shutdown cancelled");
    expect((await db.select().from(changeRequests).where(eq(changeRequests.id, c!.id)))[0]!.status).toBe("cancelled");
  });

  it("runs already approved when approved in advance, and changing the steps withdraws the approval", async () => {
    await saveUpsPlan(db, orgId, { mode: "auto", agentId, runtimeMinutes: 10, steps });
    expect(approvedInAdvance(await getUpsPlan(db, orgId))).toBe(false);
    await approveUpsPlan(db, orgId, ownerId);
    expect(approvedInAdvance(await getUpsPlan(db, orgId))).toBe(true);
    expect((await db.select().from(standardChangeTemplates).where(eq(standardChangeTemplates.key, "ups-shutdown")))[0]!.calls).toHaveLength(2);

    await readings([ups({ onBattery: true, lowBattery: true, charge: 9 })]);
    expect(await upsShutdownTick(db, orgId)).toBe("shutdown started (approved in advance)");
    const [c] = await db.select().from(changeRequests);
    expect(c).toMatchObject({ status: "approved", type: "standard" });

    const changed = await saveUpsPlan(db, orgId, { mode: "auto", agentId, runtimeMinutes: 10, steps: [steps[1]!] });
    expect(changed.approval).toBeUndefined();
    // Readings that are too old don't count.
    await setSetting(db, orgId, "ups.shutdown_run", {});
    await readings([ups({ onBattery: true, lowBattery: true })], new Date(Date.now() - 10 * 60_000));
    expect(await upsShutdownTick(db, orgId)).toBeNull();
  });
});
