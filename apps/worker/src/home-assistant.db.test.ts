// The Home Assistant module's background work, against Postgres with a fake gate.
import {
  bootstrapOrg,
  createIncident,
  createMonitorSource,
  HA_SELF_HEAL_TEMPLATE,
  parseHaConfig,
  recordMonitorResult,
  saveModule,
  selfHealTemplate,
  upsertStandardTemplate,
} from "@moss/core";
import { agents, assets, changeRequests, incidents, models, modules, monitors, networks, providers, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifyIncident, runHomeAssistantTick, selfHeal, syncInventory, type HaCaller, type HaOp, type HaResult } from "./home-assistant.js";

describe.skipIf(!TEST_DATABASE_URL)("Home Assistant module (worker)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  let sourceId: string;
  const calls: { op: HaOp; args?: Record<string, unknown> }[] = [];
  let answer: (op: HaOp) => HaResult = () => ({ ok: true, result: {} });
  const call: HaCaller = async (_orgId, op, args) => {
    calls.push({ op, args });
    return answer(op);
  };
  const owner = () => ({ type: "user" as const, id: ownerId });
  const configure = async (config: Record<string, unknown>, enabled = true) => {
    await saveModule(db, orgId, "home_assistant", { enabled, config: { host: "10.0.0.20", sourceId, mossUrl: "http://10.0.0.5:3080", ...config } }, owner());
    await db.update(modules).set({ state: {} }).where(eq(modules.orgId, orgId));
  };
  const state = async () => (await db.select().from(modules).where(eq(modules.orgId, orgId)))[0]!.state as Record<string, unknown>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("worker_ha"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    await db.insert(networks).values({ orgId, cidr: "10.0.0.0/24", status: "allowed", source: "user" });
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    const [agent] = await db.insert(agents).values({ orgId, name: "Hal", title: "Home Admin", systemPrompt: "x", modelId: model!.id }).returning();
    agentId = agent!.id;
    ({ source: { id: sourceId } } = await createMonitorSource(db, orgId, { name: "Home Assistant", kind: "generic", defaultPriority: "P3" }, owner(), { moduleKind: "home_assistant" }));
  });
  afterAll(() => close?.());
  beforeEach(() => {
    calls.length = 0;
    answer = () => ({ ok: true, result: {} });
  });

  it("health checks become monitors; a failed integration opens an incident; an unreachable Home Assistant is one monitor down", async () => {
    await configure({ health: { enabled: true, unavailableThreshold: 2 } });
    answer = () => ({
      ok: true,
      result: {
        version: "2026.9.2",
        entities: 10,
        unavailable: { count: 3, entities: [{ entity: "light.a", name: "A" }] },
        updates: [],
        integrations: { total: 5, failed: [{ domain: "unifi", title: "UniFi", state: "setup_retry", reason: "Connection refused" }] },
      },
    });
    await runHomeAssistantTick(db, call);
    const rows = await db.select().from(monitors).where(eq(monitors.sourceId, sourceId));
    const byKey = Object.fromEntries(rows.map((m) => [m.externalKey, m]));
    expect(byKey["ha:reachable"]?.state).toBe("up");
    expect(byKey["ha:integrations"]).toMatchObject({ state: "down", lastResult: expect.objectContaining({ message: "1 integration(s) not working: UniFi (setup_retry: Connection refused)" }) });
    expect(byKey["ha:updates"]?.state).toBe("up");
    expect(byKey["ha:unavailable"]?.state).toBe("degraded");
    expect(await state()).toMatchObject({ lastHealth: { ok: true, message: "Home Assistant 2026.9.2" } });

    // Not again until it's due.
    await runHomeAssistantTick(db, call);
    expect(calls.filter((c) => c.op === "health")).toHaveLength(1);

    await db.update(modules).set({ state: {} }).where(eq(modules.orgId, orgId));
    answer = () => ({ ok: false, error: "Could not reach Home Assistant at 10.0.0.20:8123: ECONNREFUSED" });
    await runHomeAssistantTick(db, call);
    const [reach] = await db.select().from(monitors).where(and(eq(monitors.sourceId, sourceId), eq(monitors.externalKey, "ha:reachable")));
    expect(reach).toMatchObject({ state: "down", lastResult: expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }) });
  });

  it("nothing runs while the module is off", async () => {
    await configure({ health: { enabled: true }, sensors: { enabled: true }, inventory: { enabled: true } }, false);
    await runHomeAssistantTick(db, call);
    expect(calls).toEqual([]);
  });

  it("sensors: published when they change, otherwise every ten minutes", async () => {
    await configure({ sensors: { enabled: true } });
    const t0 = new Date("2026-10-06T10:00:00Z");
    await runHomeAssistantTick(db, call, { now: t0 });
    expect(calls).toHaveLength(1);
    const states = calls[0]!.args!.states as { entity: string; state: string }[];
    expect(states.map((s) => s.entity)).toEqual(["sensor.moss_open_incidents", "sensor.moss_monitors_down", "sensor.moss_changes_pending", "binary_sensor.moss_agents_paused"]);

    await runHomeAssistantTick(db, call, { now: new Date(t0.getTime() + 60_000) });
    expect(calls).toHaveLength(1); // unchanged

    await createIncident(db, orgId, { type: "break_fix", title: "Printer jammed", priority: "P4" }, owner());
    await runHomeAssistantTick(db, call, { now: new Date(t0.getTime() + 120_000) });
    expect(calls).toHaveLength(2);
    await runHomeAssistantTick(db, call, { now: new Date(t0.getTime() + 13 * 60_000) });
    expect(calls).toHaveLength(3); // the ten-minute refresh
  });

  it("inventory: names, makers and models from Home Assistant; locked and off-network devices are left alone", async () => {
    const [scanned] = await db.insert(assets).values({ orgId, name: "10.0.0.50", primaryIp: "10.0.0.50", source: "agent:x" }).returning();
    const [named] = await db.insert(assets).values({ orgId, name: "My NAS", primaryIp: "10.0.0.60", primaryMac: "aa:aa:aa:aa:aa:60", source: "user" }).returning();
    const [locked] = await db.insert(assets).values({ orgId, name: "10.0.0.70", primaryIp: "10.0.0.70", locked: true, source: "user" }).returning();
    const res = await syncInventory(db, orgId, {
      ok: true,
      result: {
        total: 5,
        devices: [
          { id: "d1", name: "Living room TV", manufacturer: "LG", model: "OLED55", area: "Living room", macs: ["aa:bb:cc:dd:ee:50"], ips: ["10.0.0.50"] },
          { id: "d2", name: "Synology", manufacturer: "Synology", model: "DS920+", macs: ["aa:aa:aa:aa:aa:60"], ips: [] },
          { id: "d3", name: "Locked thing", macs: [], ips: ["10.0.0.70"] },
          { id: "d4", name: "Garage door", manufacturer: "Meross", macs: ["aa:bb:cc:dd:ee:80"], ips: ["10.0.0.80"] },
          { id: "d5", name: "Cloud weather", macs: [], ips: [] },
          { id: "d6", name: "Other network", macs: [], ips: ["192.168.9.9"] },
        ],
      },
    });
    expect(res).toEqual({ matched: 3, created: 1, locked: 1, skipped: 2 });
    const get = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!;
    expect(await get(scanned!.id)).toMatchObject({ name: "Living room TV", vendor: "LG", model: "OLED55", primaryMac: "aa:bb:cc:dd:ee:50", attributes: { homeAssistant: expect.objectContaining({ area: "Living room" }) } });
    expect(await get(named!.id)).toMatchObject({ name: "My NAS", vendor: "Synology", model: "DS920+" }); // a person's name is kept
    expect(await get(locked!.id)).toMatchObject({ name: "10.0.0.70", attributes: {} });
    const [garage] = await db.select().from(assets).where(eq(assets.primaryIp, "10.0.0.80"));
    expect(garage).toMatchObject({ name: "Garage door", source: "integration:home_assistant", primaryMac: "aa:bb:cc:dd:ee:80" });
    expect(await state()).toMatchObject({ lastInventory: res });
  });

  it("self-heal: one pre-approved power-cycle per incident, only after the monitor has been down long enough", async () => {
    const [m] = await db
      .insert(monitors)
      .values({ orgId, name: "Internet", kind: "ping", target: "1.1.1.1", failureThreshold: 1, responderAgentId: agentId })
      .returning();
    await configure({ selfHeal: { enabled: true, monitorId: m!.id, entity: "switch.modem_plug", offSeconds: 20, afterMinutes: 5, agentId } });
    const { config } = { config: parseHaConfig({ host: "10.0.0.20", selfHeal: { enabled: true, entity: "switch.modem_plug", offSeconds: 20, afterMinutes: 5 } }) };
    await upsertStandardTemplate(db, orgId, selfHealTemplate(config, "Internet"), ownerId);

    const downAt = new Date(Date.now() - 60_000);
    await recordMonitorResult(db, m!.id, { ok: false, message: "100% packet loss" }, downAt);
    const [inc] = await db.insert(incidents).values({ orgId, type: "break_fix", title: "Internet is down", priority: "P2", assignedAgentId: agentId }).returning();
    await db.update(monitors).set({ openIncidentId: inc!.id, stateChangedAt: downAt }).where(eq(monitors.id, m!.id));
    const cfg = async () => (await import("@moss/core")).loadHomeAssistant(db, orgId);

    let ha = await cfg();
    expect(await selfHeal(db, orgId, ha.config, ha.state, new Date())).toBeNull(); // down for only a minute

    const later = new Date(downAt.getTime() + 6 * 60_000);
    const changeId = await selfHeal(db, orgId, ha.config, ha.state, later);
    expect(changeId).toBeTruthy();
    const [cr] = await db.select().from(changeRequests).where(eq(changeRequests.id, changeId!));
    expect(cr).toMatchObject({
      type: "standard",
      status: "approved",
      standardTemplateKey: HA_SELF_HEAL_TEMPLATE,
      requestedByAgentId: agentId,
      incidentId: inc!.id,
      plannedCalls: [{ tool: "homeassistant_power_cycle", args: expect.objectContaining({ target: "10.0.0.20", entity: "switch.modem_plug", offSeconds: 20, token: "secret:homeassistant-token" }) }],
    });

    ha = await cfg();
    expect(await selfHeal(db, orgId, ha.config, ha.state, new Date(later.getTime() + 60 * 60_000))).toBeNull(); // same incident
    expect(await db.select().from(changeRequests).where(eq(changeRequests.incidentId, inc!.id))).toHaveLength(1);
  });

  it("notifications: new incidents at or above the chosen priority, with a link", async () => {
    await configure({ notify: { enabled: true, services: ["mobile_app_pixel", "mobile_app_tablet"], minPriority: "P2" } });
    const p1 = await createIncident(db, orgId, { type: "break_fix", title: "NAS is down", description: "Went down at 10:00.\nMore detail", priority: "P1" }, owner());
    const p3 = await createIncident(db, orgId, { type: "break_fix", title: "Slow Wi-Fi", priority: "P3" }, owner());
    await notifyIncident(db, call, p3.id);
    expect(calls).toEqual([]);
    await notifyIncident(db, call, p1.id);
    expect(calls).toEqual(
      ["mobile_app_pixel", "mobile_app_tablet"].map((service) => ({
        op: "notify",
        args: { service, title: `P1 INC-${p1.number}: NAS is down`, message: "Went down at 10:00.", url: `http://10.0.0.5:3080/incidents/${p1.id}` },
      })),
    );
    answer = () => ({ ok: false, error: "notify.mobile_app_pixel not found" });
    await notifyIncident(db, call, p1.id);
    expect(await state()).toMatchObject({ lastNotifyError: expect.stringContaining("not found") });
  });
});
