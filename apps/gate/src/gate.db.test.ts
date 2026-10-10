// End-to-end gate tests against Postgres with a fake toolbox. Run with MOSS_TEST_DATABASE_URL set.
import { approveChange, bootstrapOrg, createChangeRequest, encryptSecret, generateMasterKey, setSetting, verifyAuditLog } from "@moss/core";
import {
  agents,
  agentSkills,
  agentToolOverrides,
  auditLog,
  configBackups,
  customToolGrants,
  customTools,
  budgets,
  changeRequests,
  models,
  networks,
  providers,
  secretGrants,
  secrets,
  skills,
  tokenUsage,
  type Database,
} from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { BUILT_IN_TOOLS, type ToolDefinition } from "@moss/tools";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BACKUPS_KEPT, readBackup } from "./backups.js";
import { buildGateServer } from "./server.js";
import { createGate, type Gate } from "./service.js";
import type { ToolboxClient } from "./toolbox-client.js";

// Test-only tools: one that takes a credential, one that changes state.
const snmpGet: ToolDefinition = {
  manifest: { name: "snmp_get", class: "read", targetArgs: ["target"] },
  description: "test",
  args: z.object({ target: z.string(), community: z.string() }).strict(),
};
const restartService: ToolDefinition = {
  manifest: { name: "restart_service", class: "write", targetArgs: ["host"] },
  description: "test",
  args: z.object({ host: z.string(), service: z.string() }).strict(),
};
const TOOLS = new Map<string, ToolDefinition>([...BUILT_IN_TOOLS, ["snmp_get", snmpGet], ["restart_service", restartService]]);

const SNMP_COMMUNITY = "s3cret-community-string";

describe.skipIf(!TEST_DATABASE_URL)("policy gate (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let gate: Gate;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  let modelId: string;
  const masterKey = generateMasterKey();
  const toolboxCalls: { tool: string; args: Record<string, unknown> }[] = [];
  let toolboxReply: (tool: string, args: Record<string, unknown>) => unknown = () => ({ hosts: [] });

  const toolbox: ToolboxClient = {
    call: async (tool, args) => {
      toolboxCalls.push({ tool, args });
      return { ok: true, result: toolboxReply(tool, args), durationMs: 5 };
    },
  };

  const lastAudit = async () => (await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]!;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, {
      orgName: "Lab",
      ownerEmail: "owner@lab.test",
      ownerName: "Owner",
      ownerPassword: "a-long-test-password",
    }));
    const [provider] = await db.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    [{ id: modelId }] = await db.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    const [agent] = await db.insert(agents).values({ orgId, name: "Nina", title: "Network Admin", systemPrompt: "x", modelId }).returning();
    agentId = agent!.id;

    const [skill] = await db
      .insert(skills)
      .values({
        orgId,
        key: "network-discovery",
        name: "Network discovery",
        description: "Scan allowed networks",
        instructions: "...",
        toolGrants: ["nmap_scan", "ping", "snmp_get", "restart_service"],
      })
      .returning();
    await db.insert(agentSkills).values({ agentId, skillId: skill!.id });

    await db.insert(networks).values([
      { orgId, cidr: "192.168.1.0/24", status: "allowed", source: "user" },
      { orgId, cidr: "192.168.66.0/24", status: "off_limits", source: "user" },
      { orgId, cidr: "10.9.0.0/16", status: "unknown", source: "sensor" },
    ]);

    const secretId = randomUUID();
    await db.insert(secrets).values({
      id: secretId,
      orgId,
      name: "switch-snmp",
      type: "snmp_community",
      allowedHosts: ["192.168.1.2"],
      allowedTools: ["snmp_get"],
      ...encryptSecret(masterKey, secretId, SNMP_COMMUNITY),
    });
    await db.insert(secretGrants).values({ secretId, agentId });
    // A second secret the agent is NOT granted.
    const otherId = randomUUID();
    await db.insert(secrets).values({ id: otherId, orgId, name: "router-admin", type: "password", ...encryptSecret(masterKey, otherId, "pw") });

    gate = createGate({ db, masterKey, toolbox, tools: TOOLS });
  });
  afterAll(() => close?.());
  beforeEach(() => {
    toolboxCalls.length = 0;
    toolboxReply = () => ({ hosts: [] });
  });

  it("runs an allowed scan and audits it", async () => {
    const res = await gate.handleToolCall({ agentId, tool: "nmap_scan", args: { targets: ["192.168.1.0/24"], profile: "ping" } });
    expect(res).toMatchObject({ allowed: true, ok: true, result: { hosts: [] } });
    expect(toolboxCalls).toEqual([{ tool: "nmap_scan", args: { targets: ["192.168.1.0/24"], profile: "ping" } }]);
    expect(await lastAudit()).toMatchObject({ action: "tool.call", actorId: agentId, targetId: "nmap_scan" });
  });

  it("denies off-limits and unknown networks without touching the toolbox", async () => {
    for (const target of ["192.168.66.10", "10.9.1.1", "8.8.8.8"]) {
      const res = await gate.handleToolCall({ agentId, tool: "ping", args: { target } });
      expect(res.allowed).toBe(false);
    }
    expect(toolboxCalls).toHaveLength(0);
    expect(await lastAudit()).toMatchObject({ action: "tool.denied", details: expect.objectContaining({ code: "target_not_allowed" }) });
  });

  it("rejects unknown tools, ungranted tools and invalid arguments", async () => {
    expect(await gate.handleToolCall({ agentId, tool: "shell", args: { cmd: "id" } })).toMatchObject({ code: "unknown_tool" });
    expect(await gate.handleToolCall({ agentId, tool: "arp_scan", args: { targets: ["192.168.1.0/24"] } })).toMatchObject({
      code: "tool_not_granted",
    });
    expect(await gate.handleToolCall({ agentId, tool: "ping", args: { target: "192.168.1.1; reboot" } })).toMatchObject({
      code: "invalid_args",
    });
    expect(toolboxCalls).toHaveLength(0);
  });

  it("injects granted secrets into the toolbox call only, and redacts echoes", async () => {
    toolboxReply = (_t, args) => ({ debug: `auth with ${args.community as string} ok`, sysName: "core-switch" });
    const res = await gate.handleToolCall({ agentId, tool: "snmp_get", args: { target: "192.168.1.2", community: "secret:switch-snmp" } });
    expect(toolboxCalls[0]!.args.community).toBe(SNMP_COMMUNITY);
    expect(JSON.stringify(res)).not.toContain(SNMP_COMMUNITY);
    expect(res).toMatchObject({ allowed: true, result: { debug: "auth with [REDACTED] ok" } });

    const audit = await lastAudit();
    expect(JSON.stringify(audit)).not.toContain(SNMP_COMMUNITY);
    expect(audit.details).toMatchObject({ secretsUsed: ["switch-snmp"] });
  });

  it("refuses secrets that are ungranted or out of scope", async () => {
    expect(
      await gate.handleToolCall({ agentId, tool: "snmp_get", args: { target: "192.168.1.2", community: "secret:router-admin" } }),
    ).toMatchObject({ code: "secret_not_granted" });
    expect(
      await gate.handleToolCall({ agentId, tool: "snmp_get", args: { target: "192.168.1.3", community: "secret:switch-snmp" } }),
    ).toMatchObject({ code: "secret_scope" });
    expect(toolboxCalls).toHaveLength(0);
  });

  it("requires an approved change whose plan matches the write call", async () => {
    const args = { host: "192.168.1.5", service: "dnsmasq" };
    expect(await gate.handleToolCall({ agentId, tool: "restart_service", args })).toMatchObject({ code: "change_required" });

    const [cr] = await db
      .insert(changeRequests)
      .values({
        orgId,
        type: "normal",
        status: "submitted",
        title: "Restart dnsmasq",
        description: "DNS is stuck",
        risk: "low",
        plannedCalls: [{ tool: "restart_service", args }],
        rollbackPlan: "n/a",
        verificationPlan: "dig",
        requestedByAgentId: agentId,
      })
      .returning();
    expect(await gate.handleToolCall({ agentId, tool: "restart_service", args, changeId: cr!.id })).toMatchObject({
      code: "change_not_executable",
    });

    await db.update(changeRequests).set({ status: "approved" }).where(eq(changeRequests.id, cr!.id));
    expect(
      await gate.handleToolCall({ agentId, tool: "restart_service", args: { ...args, service: "sshd" }, changeId: cr!.id }),
    ).toMatchObject({ code: "call_not_in_change_plan" });
    expect(await gate.handleToolCall({ agentId, tool: "restart_service", args, changeId: cr!.id })).toMatchObject({ allowed: true });
    expect(toolboxCalls).toEqual([{ tool: "restart_service", args }]);
  });

  it("applies per-agent tool overrides: removing a skill's tool and adding one", async () => {
    // ping comes from the agent's skill; removing it denies the call and drops it from the tool list.
    await db.insert(agentToolOverrides).values({ agentId, tool: "ping", granted: false });
    expect(await gate.handleToolCall({ agentId, tool: "ping", args: { target: "192.168.1.1" } })).toMatchObject({ code: "tool_not_granted" });
    expect((await gate.listAgentTools(agentId)).map((t) => t.name)).not.toContain("ping");
    // arp_scan isn't in any skill; granting it lets the call through (still scope-checked).
    await db.insert(agentToolOverrides).values({ agentId, tool: "arp_scan", granted: true });
    expect(await gate.handleToolCall({ agentId, tool: "arp_scan", args: { targets: ["192.168.1.0/24"] } })).toMatchObject({ allowed: true });
    expect(await gate.handleToolCall({ agentId, tool: "arp_scan", args: { targets: ["192.168.66.0/24"] } })).toMatchObject({ code: "target_off_limits" });
    await db.delete(agentToolOverrides).where(eq(agentToolOverrides.agentId, agentId));
    expect(await gate.handleToolCall({ agentId, tool: "ping", args: { target: "192.168.1.1" } })).toMatchObject({ allowed: true });
  });

  it("stops agents that are over budget or halted by the kill switch", async () => {
    const call = { agentId, tool: "ping", args: { target: "192.168.1.1" } };
    await db.insert(budgets).values({ orgId, agentId, period: "day", unit: "tokens", hardLimit: "1000" });
    await db.insert(tokenUsage).values({ orgId, agentId, modelId, inputTokens: 900, outputTokens: 200, costUsd: "0" });
    expect(await gate.handleToolCall(call)).toMatchObject({ code: "over_budget" });
    await db.delete(budgets);

    await setSetting(db, orgId, "agents.kill_switch", true);
    expect(await gate.handleToolCall(call)).toMatchObject({ code: "kill_switch" });
    await setSetting(db, orgId, "agents.kill_switch", false);
    expect(await gate.handleToolCall(call)).toMatchObject({ allowed: true });
  });

  it("lists only granted tools, with JSON schemas, over an authenticated API", async () => {
    const token = "g".repeat(40);
    const app = buildGateServer(gate, { token });
    const unauth = await app.inject({ method: "GET", url: `/v1/agents/${agentId}/tools` });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({ method: "GET", url: `/v1/agents/${agentId}/tools`, headers: { authorization: `Bearer ${token}` } });
    const names = (res.json().tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["nmap_scan", "ping", "restart_service", "snmp_get"]);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/tool-calls",
      headers: { authorization: `Bearer ${token}` },
      payload: { agentId: "not-a-uuid", tool: "ping" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("runs custom tools through the same policy: grants, scope, declared secret only, writes need a change", async () => {
    const PLEX_TOKEN = "plex-token-value-123";
    const plexId = randomUUID();
    await db.insert(secrets).values({ id: plexId, orgId, name: "plex-token", type: "api_token", allowedHosts: ["192.168.1.20"], allowedTools: ["plex_sessions"], ...encryptSecret(masterKey, plexId, PLEX_TOKEN) });
    const spec = {
      key: "plex_sessions",
      description: "Active Plex streams on a media server",
      class: "read",
      params: { host: { type: "ip", target: true }, user: { type: "string", required: false } },
      secret: "plex-token",
      request: { method: "GET", scheme: "http", port: 32400, path: "/status/sessions", headers: { "X-Plex-Token": "{{secret}}" }, query: { user: "{{user}}" } },
      result: { pick: "$.MediaContainer.Metadata[*].title" },
    };
    const [tool] = await db.insert(customTools).values({ orgId, key: "plex_sessions", spec, source: "{}" }).returning();
    const call = (args: Record<string, unknown>) => gate.handleToolCall({ agentId, tool: "plex_sessions", args });

    // Not granted to the agent yet.
    expect(await call({ host: "192.168.1.20" })).toMatchObject({ code: "tool_not_granted" });
    await db.insert(customToolGrants).values({ toolId: tool!.id, agentId });
    expect((await gate.listAgentTools(agentId)).map((t) => t.name)).toContain("plex_sessions");

    // The secret is granted? Not yet: the declared secret is checked like any other.
    expect(await call({ host: "192.168.1.20" })).toMatchObject({ code: "secret_not_granted" });
    await db.insert(secretGrants).values({ secretId: plexId, agentId });

    toolboxReply = (_t, args) => ({ status: 200, ok: true, data: ["Film"], echo: (args.headers as Record<string, string>)["X-Plex-Token"] });
    const res = await call({ host: "192.168.1.20", user: "a b" });
    expect(toolboxCalls[0]).toEqual({
      tool: "custom_http",
      args: expect.objectContaining({ target: "192.168.1.20", port: 32400, method: "GET", path: "/status/sessions?user=a%20b", headers: { "X-Plex-Token": PLEX_TOKEN } }),
    });
    expect(res).toMatchObject({ allowed: true, result: { data: ["Film"], echo: "[REDACTED]" } });
    expect(JSON.stringify(await lastAudit())).not.toContain(PLEX_TOKEN);
    expect((await lastAudit()).details).toMatchObject({ secretsUsed: ["plex-token"] });

    toolboxCalls.length = 0;
    // Scope: outside the allowed networks, outside the secret's hosts, or a smuggled handle.
    expect(await call({ host: "192.168.66.20" })).toMatchObject({ code: "target_off_limits" });
    expect(await call({ host: "192.168.1.21" })).toMatchObject({ code: "secret_scope" });
    expect(await call({ host: "192.168.1.20", user: "secret:switch-snmp" })).toMatchObject({ code: "invalid_args" });
    expect(await gate.handleToolCall({ agentId, tool: "custom_http", args: { target: "192.168.1.20" } })).toMatchObject({ code: "unknown_tool" });

    // Disabled tools vanish, and a write tool needs an approved change.
    await db.update(customTools).set({ enabled: false }).where(eq(customTools.id, tool!.id));
    expect(await call({ host: "192.168.1.20" })).toMatchObject({ code: "unknown_tool" });
    const [restart] = await db
      .insert(customTools)
      .values({
        orgId,
        key: "nas_restart_app",
        source: "{}",
        spec: { key: "nas_restart_app", description: "Restart an app on the NAS", class: "write", params: { host: { type: "ip", target: true } }, request: { method: "POST", path: "/api/restart" } },
      })
      .returning();
    await db.insert(customToolGrants).values({ toolId: restart!.id, agentId });
    expect(await gate.handleToolCall({ agentId, tool: "nas_restart_app", args: { host: "192.168.1.30" } })).toMatchObject({ code: "change_required" });
    expect(toolboxCalls).toHaveLength(0);

    // A change request can plan a custom write tool, and once approved, exactly that call runs.
    const cr = await createChangeRequest(
      db,
      orgId,
      {
        type: "normal",
        title: "Restart the NAS app",
        description: "It stopped answering",
        plannedCalls: [{ tool: "nas_restart_app", args: { host: "192.168.1.30" } }],
        rollbackPlan: "None needed",
        verificationPlan: "The app answers again",
      },
      { type: "agent", id: agentId },
    );
    await approveChange(db, orgId, cr.id, ownerId);
    toolboxReply = () => ({ status: 200, ok: true });
    expect(await gate.handleToolCall({ agentId, tool: "nas_restart_app", args: { host: "192.168.1.31" }, changeId: cr.id })).toMatchObject({ code: "call_not_in_change_plan" });
    expect(await gate.handleToolCall({ agentId, tool: "nas_restart_app", args: { host: "192.168.1.30" }, changeId: cr.id })).toMatchObject({ allowed: true, ok: true });
    expect(toolboxCalls).toEqual([{ tool: "custom_http", args: expect.objectContaining({ target: "192.168.1.30", method: "POST", path: "/api/restart" }) }]);
  });

  it("stores config backups encrypted, returns only metadata, and decrypts them for an audited download", async () => {
    const pwId = randomUUID();
    await db.insert(secrets).values({ id: pwId, orgId, name: "pihole-pw", type: "password", allowedHosts: ["192.168.1.40"], allowedTools: ["config_backup"], ...encryptSecret(masterKey, pwId, "pi-pw") });
    await db.insert(secretGrants).values({ secretId: pwId, agentId });
    await db.update(skills).set({ toolGrants: ["nmap_scan", "ping", "snmp_get", "restart_service", "config_backup"] }).where(eq(skills.orgId, orgId));

    const CONFIG = "[dns]\nupstreams = ['1.1.1.1']\nwebpassword = 'hash-abc'\n";
    const file = (content: string) => ({
      source: "pihole",
      target: "192.168.1.40",
      filename: "pihole-teleporter-192.168.1.40.zip",
      contentType: "application/zip",
      bytes: content.length,
      sha256: "f".repeat(64),
      contentBase64: Buffer.from(content).toString("base64"),
    });
    toolboxReply = () => file(CONFIG);
    const res = await gate.handleToolCall({ agentId, tool: "config_backup", args: { target: "192.168.1.40", source: "pihole", password: "secret:pihole-pw" } });
    expect(res).toMatchObject({ allowed: true, ok: true, result: { stored: true, filename: "pihole-teleporter-192.168.1.40.zip", bytes: CONFIG.length } });
    expect(JSON.stringify(res)).not.toContain(Buffer.from(CONFIG).toString("base64"));
    expect(JSON.stringify(await lastAudit())).not.toContain("hash-abc");

    const backupId = (res as { result: { backupId: string } }).result.backupId;
    const [row] = await db.select().from(configBackups).where(eq(configBackups.id, backupId));
    expect(row!.ciphertext).not.toContain(Buffer.from(CONFIG).toString("base64"));
    expect(row).toMatchObject({ orgId, agentId, target: "192.168.1.40", source: "pihole" });

    // Download through the web-token route; it's audited, and only for users in the backup's org.
    const [owner] = await db.select().from(agents).where(eq(agents.id, agentId));
    const { users } = await import("@moss/db");
    const [user] = await db.select().from(users).where(eq(users.orgId, owner!.orgId));
    const webToken = "w".repeat(40);
    const server = buildGateServer(gate, { token: "g".repeat(40), secrets: { token: webToken, write: async () => ({ id: "x", created: true }), readBackup: (id, uid) => readBackup(db, masterKey, id, uid) } });
    const dl = await server.inject({ method: "GET", url: `/v1/backups/${backupId}?userId=${user!.id}`, headers: { authorization: `Bearer ${webToken}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe(CONFIG);
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="pihole-teleporter-192.168.1.40.zip"');
    expect(await lastAudit()).toMatchObject({ action: "backup.download", actorId: user!.id, targetId: backupId });
    expect((await server.inject({ method: "GET", url: `/v1/backups/${backupId}?userId=${user!.id}`, headers: { authorization: `Bearer ${"g".repeat(40)}` } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: `/v1/backups/${backupId}?userId=${randomUUID()}`, headers: { authorization: `Bearer ${webToken}` } })).statusCode).toBe(404);

    // Only the newest backups per device, source and file are kept.
    for (let i = 0; i < BACKUPS_KEPT + 2; i++) {
      await gate.handleToolCall({ agentId, tool: "config_backup", args: { target: "192.168.1.40", source: "pihole", password: "secret:pihole-pw" } });
    }
    expect(await db.select().from(configBackups).where(eq(configBackups.target, "192.168.1.40"))).toHaveLength(BACKUPS_KEPT);
  });

  it("leaves an intact audit chain", async () => {
    expect(await verifyAuditLog(db, orgId)).toBeNull();
  });
});
