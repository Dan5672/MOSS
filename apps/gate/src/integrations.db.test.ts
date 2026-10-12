// The gate's integration calls (Pi-hole as the example), against Postgres with a fake toolbox.
import { bootstrapOrg, createIncident, encryptSecret, generateMasterKey, saveLicence, saveModule, signLicence } from "@moss/core";
import { agents, agentToolOverrides, auditLog, models, networks, providers, secretGrants, secrets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGate, type Gate } from "./service.js";
import type { ToolboxClient } from "./toolbox-client.js";

const PASSWORD = "pihole-app-password-123";
const fixtures = join(__dirname, "../../../packages/core/src/fixtures/licence");
process.env.MOSS_LICENCE_EXTRA_PUBLIC_KEY = readFileSync(join(fixtures, "test.pub"), "utf8").trim();

describe.skipIf(!TEST_DATABASE_URL)("integration calls (gate)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let gate: Gate;
  let orgId: string;
  let ownerId: string;
  let secretId: string;
  const masterKey = generateMasterKey();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  let reply: { ok: boolean; result?: unknown; error?: string } = { ok: true, result: { blocking: "enabled", queries: 10 } };
  const toolbox: ToolboxClient = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
  const configure = (enabled: boolean, config: Record<string, unknown> = {}) =>
    saveModule(db, orgId, "pihole", { enabled, config: { host: "192.168.1.14", port: 80, scheme: "http", features: { health: true, inventory: false }, ...config } }, { type: "user", id: ownerId });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_integrations"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@home.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.66.0/24", status: "off_limits", source: "user" },
    ]);
    secretId = randomUUID();
    await db.insert(secrets).values({ id: secretId, orgId, name: "pihole-password", type: "password", allowedHosts: ["192.168.1.14"], allowedTools: ["pihole_summary", "pihole_clients"], ...encryptSecret(masterKey, secretId, PASSWORD) });
    gate = createGate({ db, masterKey, toolbox });
  });
  afterAll(() => close?.());
  beforeEach(() => {
    calls.length = 0;
    reply = { ok: true, result: { blocking: "enabled", queries: 10 } };
  });

  it("tests the connection before it's on, but runs features only when it and the feature are on", async () => {
    await configure(false);
    expect(await gate.integration({ orgId, key: "pihole", op: "test", userId: ownerId })).toEqual({ ok: true, result: { blocking: "enabled", queries: 10 } });
    expect(calls).toEqual([{ tool: "pihole_summary", args: { target: "192.168.1.14", port: 80, scheme: "http", verifyTls: false, timeoutMs: 10000, password: PASSWORD } }]);
    expect(await gate.integration({ orgId, key: "pihole", op: "summary" })).toEqual({ ok: false, error: "The Pi-hole integration is switched off" });
    await configure(true);
    expect(await gate.integration({ orgId, key: "pihole", op: "summary" })).toMatchObject({ ok: true });
    expect(await gate.integration({ orgId, key: "pihole", op: "clients" })).toEqual({ ok: false, error: "Device names is switched off" });
    // A person's Sync now runs a feature that's off on its schedule, as long as the integration is on.
    expect(await gate.integration({ orgId, key: "pihole", op: "sync:inventory", userId: ownerId })).toMatchObject({ ok: true });
    expect(calls.at(-1)!.tool).toBe("pihole_clients");
    const [audit] = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    expect(audit).toMatchObject({ action: "module.call", targetId: "pihole", details: { op: "sync:inventory", args: { password: "secret:pihole-password" } } });
    expect(await gate.integration({ orgId, key: "nope", op: "test" })).toEqual({ ok: false, error: "Unknown integration" });
    // A caller can't point a call elsewhere or swap its credential: only arguments the operation lists are used.
    await gate.integration({ orgId, key: "pihole", op: "summary", args: { target: "192.168.66.6", password: "secret:other" } });
    expect(calls.at(-1)!.args).toMatchObject({ target: "192.168.1.14", password: PASSWORD });
  });

  it("applies the network policy and the credential's own scope, and never returns the password", async () => {
    await configure(true, { host: "192.168.66.5" });
    expect(await gate.integration({ orgId, key: "pihole", op: "summary" })).toMatchObject({ ok: false, error: expect.stringMatching(/^Blocked by policy: .*off-limits/) });
    await configure(true, { host: "192.168.1.15" });
    expect(await gate.integration({ orgId, key: "pihole", op: "summary" })).toEqual({ ok: false, error: "Secret pihole-password may not be used against 192.168.1.15" });
    expect(calls).toEqual([]);

    await configure(true);
    reply = { ok: false, error: `Pi-hole said: bad password ${PASSWORD}` };
    const failed = await gate.integration({ orgId, key: "pihole", op: "summary" });
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
    reply = { ok: true, result: { echo: PASSWORD } };
    expect(JSON.stringify(await gate.integration({ orgId, key: "pihole", op: "summary" }))).not.toContain(PASSWORD);
    await db.delete(secrets).where(eq(secrets.id, secretId));
    expect(await gate.integration({ orgId, key: "pihole", op: "summary" })).toEqual({ ok: false, error: "Add Pi-hole's credential first" });
  });

  it("calls each Docker host in turn without a credential, keeping one host's failure to that host", async () => {
    await saveModule(db, orgId, "docker", { enabled: true, config: { hosts: [{ host: "192.168.1.20", port: 2375 }, { host: "192.168.66.9", port: 2375 }], features: { health: false, inventory: true } } }, { type: "user", id: ownerId });
    reply = { ok: true, result: { host: "docker1", containers: [] } };
    // The worker names the feature: inventory runs although health (the same operation) is off.
    const res = await gate.integration({ orgId, key: "docker", op: "inventory" });
    expect(res).toMatchObject({
      ok: true,
      result: { hosts: [{ host: "192.168.1.20", ok: true, result: { host: "docker1" } }, { host: "192.168.66.9", ok: false, error: expect.stringMatching(/^Blocked by policy/) }] },
    });
    expect(calls).toEqual([{ tool: "docker_api_containers", args: { target: "192.168.1.20", port: 2375, timeoutMs: 10000, checkUpdates: false } }]);
    expect(await gate.integration({ orgId, key: "docker", op: "health" })).toEqual({ ok: false, error: "Health checks is switched off" });
  });

  it("builds a PagerDuty page from the incident itself, whatever the worker sends", async () => {
    const lic = signLicence(
      { v: 1, kid: "test", id: "l1", licensee: "Home", plan: "business", features: ["pagerduty"], issued: "2030-01-01T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" },
      readFileSync(join(fixtures, "test.key"), "utf8"),
    );
    await saveLicence(db, orgId, lic, { type: "user", id: ownerId });
    const keyId = randomUUID();
    await db.insert(secrets).values({ id: keyId, orgId, name: "pagerduty-routing-key", type: "api_token", allowedTools: ["pagerduty_event", "pagerduty_change"], ...encryptSecret(masterKey, keyId, "r".repeat(32)) });
    await saveModule(db, orgId, "pagerduty", { enabled: true, config: {} }, { type: "user", id: ownerId });
    const inc = await createIncident(db, orgId, { type: "incident", title: "NAS is down", priority: "P1" }, { type: "user", id: ownerId });
    reply = { ok: true, result: {} };
    const sent = await gate.integration({ orgId, key: "pagerduty", op: "event", args: { incidentId: inc.id, action: "acknowledge", summary: "Click https://evil.example", severity: "info" } });
    expect(sent).toMatchObject({ ok: true });
    expect(calls.at(-1)!.args).toMatchObject({ action: "trigger", dedupKey: inc.id, summary: `INC-${String(inc.number).padStart(4, "0")} NAS is down`, severity: "critical" });
    expect(await gate.integration({ orgId, key: "pagerduty", op: "event", args: { incidentId: randomUUID(), action: "trigger" } })).toEqual({ ok: false, error: "No such incident" });
    // A secret limited to some hosts is never used by a call without a target (the same rule as agents' calls).
    await db.update(secrets).set({ allowedHosts: ["192.168.1.40"] }).where(eq(secrets.id, keyId));
    expect(await gate.integration({ orgId, key: "pagerduty", op: "event", args: { incidentId: inc.id, action: "trigger" } })).toEqual({
      ok: false,
      error: "Secret pagerduty-routing-key is host-scoped but the call has no target",
    });
  });

  it("lets agents use a cloud integration's tools only while it's on", async () => {
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    const [agent] = await db.insert(agents).values({ orgId, name: "Tess", title: "Network Admin", systemPrompt: "x", modelId: model!.id }).returning();
    const keyId = randomUUID();
    await db.insert(secrets).values({ id: keyId, orgId, name: "tailscale-api-key", type: "api_token", allowedTools: ["tailscale_devices"], ...encryptSecret(masterKey, keyId, "tskey-api-abc") });
    await db.insert(agentToolOverrides).values({ agentId: agent!.id, tool: "tailscale_devices", granted: true });
    await db.insert(secretGrants).values({ secretId: keyId, agentId: agent!.id });
    const ask = () => gate.handleToolCall({ agentId: agent!.id, tool: "tailscale_devices", args: { apiKey: "secret:tailscale-api-key" } });
    expect(await ask()).toMatchObject({ allowed: false, code: "module_disabled" });
    await saveModule(db, orgId, "tailscale", { enabled: true, config: {} }, { type: "user", id: ownerId });
    reply = { ok: true, result: { devices: [] } };
    expect(await ask()).toMatchObject({ allowed: true, ok: true });
    expect(calls.at(-1)).toEqual({ tool: "tailscale_devices", args: { apiKey: "tskey-api-abc", tailnet: "-", timeoutMs: 10000 } });
    // System tools (signing in) are never an agent's, even with a grant.
    await db.insert(agentToolOverrides).values({ agentId: agent!.id, tool: "oidc_exchange", granted: true });
    expect(await gate.handleToolCall({ agentId: agent!.id, tool: "oidc_exchange", args: {} })).toMatchObject({ allowed: false, code: "unknown_tool" });
  });
});
