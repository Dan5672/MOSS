// The gate's Home Assistant module calls and module gating, against Postgres with a fake toolbox.
import { bootstrapOrg, encryptSecret, generateMasterKey, HA_TOKEN_SECRET, saveModule, setSetting } from "@moss/core";
import { agents, agentToolOverrides, auditLog, models, networks, providers, secretGrants, secrets, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildGateServer } from "./server.js";
import { createGate, type Gate } from "./service.js";
import { moduleManagerOrg } from "./home-assistant.js";
import type { ToolboxClient } from "./toolbox-client.js";

const TOKEN = "eyJ-long-lived-home-assistant-token";
const GATE_TOKEN = "g".repeat(40);
const WEB_TOKEN = "w".repeat(40);

describe.skipIf(!TEST_DATABASE_URL)("Home Assistant module (gate)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let gate: Gate;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  let secretId: string;
  const masterKey = generateMasterKey();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let reply: { ok: boolean; result?: unknown; error?: string } = { ok: true, result: { version: "2026.9.2" } };
  const toolbox: ToolboxClient = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
  const owner = () => ({ type: "user" as const, id: ownerId });
  const configure = (enabled: boolean, config: Record<string, unknown> = {}) =>
    saveModule(db, orgId, "home_assistant", { enabled, config: { host: "192.168.1.20", ...config } }, owner());
  const lastAudit = async () => (await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]!;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_ha"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@home.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.66.0/24", status: "off_limits", source: "user" },
    ]);
    secretId = randomUUID();
    await db.insert(secrets).values({ id: secretId, orgId, name: HA_TOKEN_SECRET, type: "api_token", allowedHosts: ["192.168.1.20"], allowedTools: [], ...encryptSecret(masterKey, secretId, TOKEN) });
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    const [agent] = await db.insert(agents).values({ orgId, name: "Hal", title: "Home Admin", systemPrompt: "x", modelId: model!.id }).returning();
    agentId = agent!.id;
    await db.insert(agentToolOverrides).values({ agentId, tool: "homeassistant_states", granted: true });
    await db.insert(secretGrants).values({ secretId, agentId });
    gate = createGate({ db, masterKey, toolbox });
  });
  afterAll(() => close?.());
  beforeEach(() => {
    calls.length = 0;
    reply = { ok: true, result: { version: "2026.9.2" } };
  });

  it("test: works before the module is on, sends the decrypted token to the configured address, audits only the handle", async () => {
    await configure(false);
    const res = await gate.homeAssistant({ orgId, op: "test", userId: ownerId });
    expect(res).toEqual({ ok: true, result: { version: "2026.9.2" } });
    expect(calls).toEqual([{ tool: "homeassistant_health", args: { target: "192.168.1.20", port: 8123, scheme: "http", verifyTls: false, timeoutMs: 10_000, token: TOKEN } }]);
    const audit = await lastAudit();
    expect(audit).toMatchObject({ action: "module.call", actorType: "user", actorId: ownerId, targetId: "home_assistant" });
    expect(JSON.stringify(audit.details)).not.toContain(TOKEN);
    expect(JSON.stringify(audit.details)).toContain(`secret:${HA_TOKEN_SECRET}`);
  });

  it("each feature's call only runs while the module and that feature are on", async () => {
    await configure(false, { health: { enabled: true } });
    expect(await gate.homeAssistant({ orgId, op: "health" })).toEqual({ ok: false, error: "The Home Assistant module is switched off" });
    await configure(true, { health: { enabled: false } });
    expect(await gate.homeAssistant({ orgId, op: "health" })).toEqual({ ok: false, error: "Health checks are switched off" });
    await configure(true, { health: { enabled: true } });
    expect(await gate.homeAssistant({ orgId, op: "health" })).toMatchObject({ ok: true });
    expect(await gate.homeAssistant({ orgId, op: "publish", args: { states: [{ entity: "sensor.moss_x", state: "1" }] } })).toEqual({ ok: false, error: "Status sensors are switched off" });
    expect(calls).toHaveLength(1);
    expect((await lastAudit()).action).toBe("module.call_failed");
  });

  it("notify: only to the module's own notify services", async () => {
    await configure(true, { notify: { enabled: true, services: ["mobile_app_pixel"] } });
    const sent = await gate.homeAssistant({ orgId, op: "notify", args: { service: "mobile_app_pixel", title: "INC-1", message: "NAS down" } });
    expect(sent.ok).toBe(true);
    expect(calls[0]).toMatchObject({ tool: "homeassistant_notify", args: { service: "mobile_app_pixel", title: "INC-1" } });
    expect(await gate.homeAssistant({ orgId, op: "notify", args: { service: "mobile_app_someone_else", title: "x", message: "y" } })).toEqual({
      ok: false,
      error: "notify.mobile_app_someone_else isn't one of the module's notify services",
    });
    expect(calls).toHaveLength(1);
  });

  it("network scope and the token's host scope still apply", async () => {
    await configure(true, { host: "192.168.66.5", health: { enabled: true } });
    expect(await gate.homeAssistant({ orgId, op: "health" })).toMatchObject({ ok: false, error: expect.stringMatching(/^Blocked by policy: .*off-limits/) });
    await configure(true, { host: "192.168.1.21", health: { enabled: true } });
    expect(await gate.homeAssistant({ orgId, op: "health" })).toEqual({ ok: false, error: `The ${HA_TOKEN_SECRET} secret may not be used against 192.168.1.21` });
    expect(calls).toHaveLength(0);
  });

  it("the token never comes back in an error", async () => {
    await configure(true, { health: { enabled: true } });
    reply = { ok: false, error: `Home Assistant said: bad token ${TOKEN}` };
    const res = await gate.homeAssistant({ orgId, op: "health" });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("agents can't use Home Assistant tools while the module is off", async () => {
    await configure(false);
    const denied = await gate.handleToolCall({ agentId, tool: "homeassistant_states", args: { target: "192.168.1.20", token: `secret:${HA_TOKEN_SECRET}` } });
    expect(denied).toMatchObject({ allowed: false, code: "module_disabled" });
    expect((await gate.listAgentTools(agentId)).map((t) => t.name)).not.toContain("homeassistant_states");

    await configure(true);
    reply = { ok: true, result: { total: 0, entities: [] } };
    const allowed = await gate.handleToolCall({ agentId, tool: "homeassistant_states", args: { target: "192.168.1.20", token: `secret:${HA_TOKEN_SECRET}` } });
    expect(allowed).toMatchObject({ allowed: true, ok: true });
    expect((await gate.listAgentTools(agentId)).map((t) => t.name)).toContain("homeassistant_states");
  });

  it("a password secret given as an API key is refused with how to sign in instead", async () => {
    const id = randomUUID();
    await db.insert(secrets).values({ id, orgId, name: "Unifi-AP", type: "password", allowedHosts: ["192.168.1.1"], allowedTools: [], ...encryptSecret(masterKey, id, "pw") });
    await db.insert(secretGrants).values({ secretId: id, agentId });
    await db.insert(agentToolOverrides).values({ agentId, tool: "unifi_firewall", granted: true });

    const wrong = await gate.handleToolCall({ agentId, tool: "unifi_firewall", args: { controller: "192.168.1.1", apiKey: "secret:Unifi-AP" } });
    expect(wrong).toMatchObject({ allowed: false, code: "invalid_args", reason: expect.stringContaining('pass username (the account name) and password: "secret:Unifi-AP"') });
    expect(calls).toHaveLength(0);

    reply = { ok: true, result: { firewall: "rules" } };
    const right = await gate.handleToolCall({ agentId, tool: "unifi_firewall", args: { controller: "192.168.1.1", username: "moss", password: "secret:Unifi-AP" } });
    expect(right).toMatchObject({ allowed: true, ok: true });
    expect(calls[0]!.args).toMatchObject({ username: "moss", password: "pw" });

    // With a username stored on the secret, the agent can leave it out.
    calls.length = 0;
    await db.update(secrets).set({ username: "sysadmin" }).where(eq(secrets.id, id));
    const filled = await gate.handleToolCall({ agentId, tool: "unifi_firewall", args: { controller: "192.168.1.1", password: "secret:Unifi-AP" } });
    expect(filled).toMatchObject({ allowed: true, ok: true });
    expect(calls[0]!.args).toMatchObject({ username: "sysadmin", password: "pw" });
    // One the agent gives itself wins.
    calls.length = 0;
    await gate.handleToolCall({ agentId, tool: "unifi_firewall", args: { controller: "192.168.1.1", username: "other", password: "secret:Unifi-AP" } });
    expect(calls[0]!.args).toMatchObject({ username: "other" });
  });

  it("the CVE lookup only runs once the owner allows it", async () => {
    await db.insert(agentToolOverrides).values({ agentId, tool: "vuln_scan", granted: true });
    const args = { target: "192.168.1.30", profile: "cve" };
    expect(await gate.handleToolCall({ agentId, tool: "vuln_scan", args })).toMatchObject({ allowed: false, code: "setting_disabled" });
    reply = { ok: true, result: { ports: [] } };
    expect(await gate.handleToolCall({ agentId, tool: "vuln_scan", args: { ...args, profile: "safe" } })).toMatchObject({ allowed: true });
    await setSetting(db, orgId, "tools.allow_vulners", true);
    expect(await gate.handleToolCall({ agentId, tool: "vuln_scan", args })).toMatchObject({ allowed: true });
  });

  it("system tools can never be called by an agent", async () => {
    await configure(true);
    const res = await gate.handleToolCall({ agentId, tool: "homeassistant_notify", args: { target: "192.168.1.20", token: `secret:${HA_TOKEN_SECRET}`, service: "x", title: "t", message: "m" } });
    expect(res).toMatchObject({ allowed: false, code: "unknown_tool" });
  });

  it("HTTP: a person's calls need integrations.manage; the worker's route can't run 'test'", async () => {
    const app = buildGateServer(gate, { token: GATE_TOKEN, secrets: { token: WEB_TOKEN, write: async () => ({ id: "x", created: true }), userOrg: (id) => moduleManagerOrg(db, id) } });
    await configure(true, { inventory: { enabled: true } });
    reply = { ok: true, result: { total: 0, devices: [] } };

    const asOwner = await app.inject({ method: "POST", url: "/v1/web/modules/home-assistant/devices", headers: { authorization: `Bearer ${WEB_TOKEN}` }, payload: { userId: ownerId } });
    expect(asOwner.json()).toEqual({ ok: true, result: { total: 0, devices: [] } });

    const [viewer] = await db.insert(users).values({ orgId, email: "v@home.test", displayName: "V", passwordHash: "x" }).returning();
    const asViewer = await app.inject({ method: "POST", url: "/v1/web/modules/home-assistant/test", headers: { authorization: `Bearer ${WEB_TOKEN}` }, payload: { userId: viewer!.id } });
    expect(asViewer.statusCode).toBe(403);

    const wrongToken = await app.inject({ method: "POST", url: "/v1/web/modules/home-assistant/test", headers: { authorization: `Bearer ${GATE_TOKEN}` }, payload: { userId: ownerId } });
    expect(wrongToken.statusCode).toBe(401);
    const workerTest = await app.inject({ method: "POST", url: "/v1/modules/home-assistant/test", headers: { authorization: `Bearer ${GATE_TOKEN}` }, payload: { orgId } });
    expect(workerTest.statusCode).toBe(404);
    await db.delete(users).where(eq(users.id, viewer!.id));
  });
});
