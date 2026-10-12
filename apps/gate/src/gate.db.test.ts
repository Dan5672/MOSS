// End-to-end gate tests against Postgres with a fake toolbox. Run with MOSS_TEST_DATABASE_URL set.
import { approveChange, bootstrapOrg, createChangeRequest, encryptSecret, generateMasterKey, setSetting, verifyAuditLog } from "@moss/core";
import {
  agentRuns,
  agents,
  agentSkills,
  agentToolOverrides,
  auditLog,
  configBackups,
  customToolGrants,
  customTools,
  hostPins,
  budgets,
  changeRequests,
  models,
  networks,
  providers,
  secretGrants,
  secrets,
  skills,
  tokenUsage,
  userRoles,
  users,
  type Database,
} from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { BUILT_IN_TOOLS, type ToolDefinition } from "@moss/tools";
import { desc, eq, sql } from "drizzle-orm";
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
    for (const target of ["192.168.66.10", "10.9.1.1", "172.16.9.9"]) {
      const res = await gate.handleToolCall({ agentId, tool: "ping", args: { target } });
      expect(res.allowed).toBe(false);
    }
    expect(toolboxCalls).toHaveLength(0);
    expect(await lastAudit()).toMatchObject({ action: "tool.denied", details: expect.objectContaining({ code: "target_not_allowed" }) });
    // A scanner may not reach a public address; a light check may (below).
    expect(await gate.handleToolCall({ agentId, tool: "nmap_scan", args: { targets: ["8.8.8.8"], profile: "ping" } })).toMatchObject({ allowed: false });
    expect(toolboxCalls).toHaveLength(0);
    expect(await gate.handleToolCall({ agentId, tool: "ping", args: { target: "8.8.8.8" } })).toMatchObject({ allowed: true });
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

  it("pins a device's certificate the first time it gets a credential, and flags a changed one", async () => {
    const trusts: unknown[] = [];
    let presented = "AA:11";
    const pinning = createGate({
      db,
      masterKey,
      tools: TOOLS,
      toolbox: {
        call: async (_tool, _args, _signal, trust) => {
          trusts.push(trust);
          const key = "tls:192.168.1.2:443";
          const pinned = trust?.pins?.[key];
          const seen = { [key]: presented };
          return pinned && pinned !== presented ? { ok: false, error: "different TLS certificate", seen } : { ok: true, result: {}, seen };
        },
      },
    });
    const call = () => pinning.handleToolCall({ agentId, tool: "snmp_get", args: { target: "192.168.1.2", community: "secret:switch-snmp" } });
    expect(await call()).toMatchObject({ ok: true });
    expect(trusts[0]).toEqual({ pins: {} });
    expect(await call()).toMatchObject({ ok: true });
    expect(trusts[1]).toEqual({ pins: { "tls:192.168.1.2:443": "AA:11" } });

    presented = "BB:22";
    expect(await call()).toMatchObject({ ok: false, error: "different TLS certificate" });
    const [pin] = await db.select().from(hostPins).where(eq(hostPins.host, "192.168.1.2"));
    expect(pin).toMatchObject({ fingerprint: "AA:11", changedTo: "BB:22" });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "host_pin.mismatch"))).length).toBe(1);

    // Calls without a credential aren't pinned; the owner can turn pinning off, or ask for trusted certificates.
    await pinning.handleToolCall({ agentId, tool: "nmap_scan", args: { targets: ["192.168.1.0/24"], profile: "ping" } });
    expect(trusts).toHaveLength(4);
    expect(trusts[3]).toBeUndefined();
    await setSetting(db, orgId, "tools.pin_hosts", false);
    await setSetting(db, orgId, "tools.verify_tls", true);
    expect(await call()).toMatchObject({ ok: true });
    expect(trusts[4]).toEqual({ verifyTls: true });
    await setSetting(db, orgId, "tools.pin_hosts", true);
    await setSetting(db, orgId, "tools.verify_tls", false);
    await db.delete(hostPins);
  });

  it("accepts a renewed certificate a trusted authority signed, and holds a new port's key for a person", async () => {
    let presented: Record<string, string> = { "tls:192.168.1.2:443": "AA:11" };
    const pinning = createGate({
      db,
      masterKey,
      tools: TOOLS,
      toolbox: { call: async () => ({ ok: true, result: {}, seen: presented }) },
    });
    const call = () => pinning.handleToolCall({ agentId, tool: "snmp_get", args: { target: "192.168.1.2", community: "secret:switch-snmp" } });
    await call();
    await setSetting(db, orgId, "tools.verify_tls", true);
    presented = { "tls:192.168.1.2:443": "CC:33" };
    await call();
    expect((await db.select().from(hostPins).where(eq(hostPins.port, 443)))[0]).toMatchObject({ fingerprint: "CC:33", changedTo: null });
    await setSetting(db, orgId, "tools.verify_tls", false);

    // A port not used before, with a key the device hasn't shown: waits for a person (and the toolbox refused it).
    presented = { "tls:192.168.1.2:8443": "DD:44" };
    await call();
    expect((await db.select().from(hostPins).where(eq(hostPins.port, 8443)))[0]).toMatchObject({ fingerprint: "", changedTo: "DD:44" });
    // Only the call's own devices are recorded.
    presented = { "tls:10.9.9.9:443": "EE:55" };
    await call();
    expect(await db.select().from(hostPins).where(eq(hostPins.host, "10.9.9.9"))).toHaveLength(0);
    await db.delete(hostPins);
  });

  it("lets work a person started use credentials only if they can manage them, when the owner says so", async () => {
    const [viewer] = await db.insert(users).values({ orgId, email: "viewer@h.test", displayName: "V" }).returning();
    const [viewerRole] = await db.execute<{ id: string }>(sql`select id from roles where org_id = ${orgId} and key = 'viewer'`);
    await db.insert(userRoles).values({ userId: viewer!.id, roleId: viewerRole!.id });
    const [byViewer] = await db.insert(agentRuns).values({ orgId, agentId, trigger: "chat", requestedByUserId: viewer!.id }).returning();
    const [byOwner] = await db.insert(agentRuns).values({ orgId, agentId, trigger: "chat", requestedByUserId: ownerId }).returning();
    const call = (runId: string) => gate.handleToolCall({ agentId, runId, tool: "snmp_get", args: { target: "192.168.1.2", community: "secret:switch-snmp" } });
    expect(await call(byViewer!.id)).toMatchObject({ allowed: true });
    await setSetting(db, orgId, "agents.credentials_need_manager", true);
    expect(await call(byViewer!.id)).toMatchObject({ allowed: false, code: "setting_disabled" });
    expect(await call(byOwner!.id)).toMatchObject({ allowed: true });
    // Carrying out a change someone approved is fine, whoever asked for it.
    const args = { target: "192.168.1.2", community: "secret:switch-snmp" };
    const cr = await createChangeRequest(db, orgId, { type: "normal", title: "t", description: "d", rollbackPlan: "r", verificationPlan: "v", plannedCalls: [{ tool: "snmp_get", args }] }, { type: "agent", id: agentId }, { tools: TOOLS });
    await approveChange(db, orgId, cr.id, ownerId);
    const [forChange] = await db.insert(agentRuns).values({ orgId, agentId, trigger: "event", triggerRef: cr.id, requestedByUserId: viewer!.id }).returning();
    expect(await gate.handleToolCall({ agentId, runId: forChange!.id, changeId: cr.id, tool: "snmp_get", args })).toMatchObject({ allowed: true });
    // ...but not by naming that change from another run.
    expect(await gate.handleToolCall({ agentId, runId: byViewer!.id, changeId: cr.id, tool: "snmp_get", args })).toMatchObject({ allowed: false, code: "setting_disabled" });
    await setSetting(db, orgId, "agents.credentials_need_manager", false);
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
    // Each step runs once: approving a change doesn't approve doing it again and again.
    expect(await gate.handleToolCall({ agentId, tool: "restart_service", args, changeId: cr!.id })).toMatchObject({ code: "call_already_run" });
    expect(toolboxCalls).toHaveLength(1);

    // Without a window of its own, a change may run for 24 hours from its approval.
    const [late] = await db
      .insert(changeRequests)
      .values({ ...cr!, id: undefined, number: undefined, status: "approved", executedCalls: [], createdAt: new Date(Date.now() - 25 * 3_600_000) } as never)
      .returning();
    expect(await gate.handleToolCall({ agentId, tool: "restart_service", args, changeId: late!.id })).toMatchObject({ code: "change_outside_window" });
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

    // A call already running stops when the kill switch goes on.
    const slow = createGate({
      db,
      masterKey,
      toolbox: { call: (_tool, _args, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))) },
    });
    const running = slow.handleToolCall(call);
    await new Promise((r) => setTimeout(r, 200));
    await setSetting(db, orgId, "agents.kill_switch", true);
    expect(await running).toMatchObject({ allowed: true, ok: false, error: "Stopped: the kill switch was turned on" });
    await setSetting(db, orgId, "agents.kill_switch", false);
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
    const [viewer] = await db.insert(users).values({ orgId: owner!.orgId, email: "viewer@backup.test", displayName: "V", passwordHash: "x" }).returning();
    expect((await server.inject({ method: "GET", url: `/v1/backups/${backupId}?userId=${viewer!.id}`, headers: { authorization: `Bearer ${webToken}` } })).statusCode).toBe(404);
    await db.delete(users).where(eq(users.id, viewer!.id));

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
