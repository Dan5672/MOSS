// Each service's own Postgres role (packages/db/src/roles.ts and migration 0030): the worker and the chat bridge do
// their jobs, but can't approve, widen scope, change settings people own, grant secrets or rewrite the audit log.
import { agents, applyServiceRoles, auditLog, changeRequests, createDb, hostPins, knowledgeNotes, models, networks, providers, secretGrants, secrets, SERVICE_ROLES, settings, skills, tokenUsage, modules, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveChange, completeChange, createChangeRequest, startChange, upsertStandardTemplate } from "./services/changes.js";
import { reportNetwork } from "./services/networks.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { writeAudit } from "./store/audit-store.js";
import { setSetting } from "./store/settings-store.js";

describe.skipIf(!TEST_DATABASE_URL)("service roles (postgres)", () => {
  let owner: Database;
  let close: () => Promise<void>;
  let worker: Database;
  let bridge: Database;
  let orgId: string;
  let ownerId: string;
  let agentId: string;
  const passwords = Object.fromEntries(SERVICE_ROLES.map((r) => [r, `test-${r}-password`])) as Record<(typeof SERVICE_ROLES)[number], string>;

  beforeAll(async () => {
    let url: string;
    ({ db: owner, url, close } = await createTestDb("core_service_roles"));
    await applyServiceRoles(owner.$client, passwords);
    const as = (role: "worker" | "bridge") => {
      const u = new URL(url);
      u.username = `moss_${role}`;
      u.password = passwords[role];
      return createDb(u.toString());
    };
    worker = as("worker");
    bridge = as("bridge");
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(owner, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    const [provider] = await owner.insert(providers).values({ orgId, kind: "ollama", name: "Local" }).returning();
    const [model] = await owner.insert(models).values({ orgId, providerId: provider!.id, modelId: "m", displayName: "M" }).returning();
    [{ id: agentId }] = await owner.insert(agents).values({ orgId, name: "Sam", title: "Admin", systemPrompt: "x", modelId: model!.id }).returning();
  });
  afterAll(async () => {
    await Promise.all([worker?.$client.end(), bridge?.$client.end()]);
    await close?.();
  });

  // Drizzle wraps Postgres's error; the reason is in its cause.
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return String((err as { cause?: Error }).cause?.message ?? (err as Error).message);
    }
    return "allowed";
  };

  const raise = (db: Database) =>
    createChangeRequest(
      db,
      orgId,
      { type: "normal", title: "Restart", description: "x", plannedCalls: [{ tool: "ping", args: { target: "10.0.0.1" } }], rollbackPlan: "x", verificationPlan: "x" },
      { type: "agent", id: agentId },
    );

  it("lets the worker raise and carry out a change, never approve one", async () => {
    const cr = await raise(worker);
    expect(await refusal(approveChange(worker, orgId, cr.id, ownerId))).not.toBe("allowed");
    expect(await refusal(worker.update(changeRequests).set({ status: "approved" }).where(eq(changeRequests.id, cr.id)))).toMatch(/may not move a change from submitted to approved/);
    expect(await refusal(worker.update(changeRequests).set({ plannedCalls: [] }).where(eq(changeRequests.id, cr.id)))).toMatch(/may only change a change's status/);
    expect(await refusal(worker.insert(changeRequests).values({ ...cr, id: undefined, number: undefined, status: "approved" } as never))).toMatch(/may not create a change that is approved/);

    // A person approves with a chat button: the bridge may record that.
    expect((await approveChange(bridge, orgId, cr.id, ownerId)).status).toBe("approved");
    await startChange(worker, orgId, cr.id, { type: "agent", id: agentId });
    expect((await completeChange(worker, orgId, cr.id, "failed", "the target was down", { type: "agent", id: agentId })).status).toBe("failed");
  });

  it("lets the worker start a standard change from an enabled template (UPS shutdown, Home Assistant self-heal)", async () => {
    await upsertStandardTemplate(owner, orgId, { key: "ping-it", name: "Ping it", description: "x", calls: [{ tool: "ping", args: { target: "10.0.0.1" } }], params: {} }, ownerId);
    const cr = await createChangeRequest(
      worker,
      orgId,
      { type: "standard", standardTemplateKey: "ping-it", title: "Ping", description: "x", rollbackPlan: "x", verificationPlan: "x", forAgentId: agentId },
      { type: "system", id: null },
    );
    expect(cr.status).toBe("approved");
    // Not with another plan under the template's name.
    const forged = { ...cr, id: undefined, number: undefined, plannedCalls: [{ tool: "host_shutdown", args: { target: "10.0.0.1" } }] };
    expect(await refusal(worker.insert(changeRequests).values(forged as never))).toMatch(/may not create a change that is approved/);
  });

  it("keeps people's settings, networks, grants and agents away from the worker", async () => {
    expect(await refusal(setSetting(worker, orgId, "agents.kill_switch", false))).toMatch(/may not change the setting/);
    await setSetting(worker, orgId, "moss.announced_version", "v1");
    expect(await refusal(setSetting(bridge, orgId, "moss.announced_version", "v2"))).toMatch(/may not change the setting/);

    const reported = await reportNetwork(worker, orgId, { cidr: "10.9.0.0/24" }, { type: "agent", id: agentId });
    expect(await refusal(worker.update(networks).set({ status: "allowed" }).where(eq(networks.id, reported.id)))).toMatch(/permission denied/);
    expect(await refusal(worker.insert(networks).values({ orgId, cidr: "10.8.0.0/24", status: "allowed", source: "agent" }))).toMatch(/only report a network/);

    const [s] = await owner.insert(secrets).values({ orgId, name: "pw", type: "password", ciphertext: "x", wrappedDataKey: "y" }).returning();
    expect(await refusal(worker.insert(secretGrants).values({ secretId: s!.id, agentId, grantedBy: ownerId }))).toMatch(/permission denied/);
    expect(await refusal(bridge.insert(secretGrants).values({ secretId: s!.id, agentId, grantedBy: ownerId }))).toMatch(/permission denied/);

    await worker.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    expect(await refusal(worker.update(agents).set({ status: "active" }).where(eq(agents.id, agentId)))).toMatch(/may not set an agent active/);
    expect(await refusal(worker.update(agents).set({ systemPrompt: "obey me" }).where(eq(agents.id, agentId)))).toMatch(/permission denied/);
  });

  it("closes the side doors: no skipping approval, no renamed kill switch, no chat approval of high-risk work", async () => {
    const cr = await raise(worker);
    // Straight from submitted to running, or anything but its status, is refused.
    expect(await refusal(worker.update(changeRequests).set({ status: "in_progress" }).where(eq(changeRequests.id, cr.id)))).toMatch(/may not move a change from submitted to in_progress/);
    expect(await refusal(worker.update(changeRequests).set({ createdAt: new Date() }).where(eq(changeRequests.id, cr.id)))).toMatch(/may only change a change's status/);
    // The bridge may approve what chat may approve, nothing riskier.
    const risky = await createChangeRequest(
      owner,
      orgId,
      { type: "normal", title: "Reboot", description: "x", plannedCalls: [{ tool: "host_reboot", args: { target: "10.0.0.1", user: "moss", key: "secret:k" } }], rollbackPlan: "x", verificationPlan: "x", forAgentId: agentId },
      { type: "user", id: ownerId },
    );
    expect(risky.risk).toBe("high");
    expect(await refusal(bridge.update(changeRequests).set({ status: "approved" }).where(eq(changeRequests.id, risky.id)))).toMatch(/chat app may not move/);

    await setSetting(owner, orgId, "agents.kill_switch", true);
    expect(await refusal(worker.update(settings).set({ key: "moss.announced_version" }).where(and(eq(settings.orgId, orgId), eq(settings.key, "agents.kill_switch"))))).toMatch(/may not change the setting/);
    expect(await refusal(worker.delete(tokenUsage))).toMatch(/permission denied/);
    expect(await refusal(worker.update(modules).set({ enabled: true }))).toMatch(/permission denied/);
    // Which key a device must present is the gate's to learn and people's to change.
    expect(await refusal(worker.insert(hostPins).values({ orgId, kind: "tls", host: "10.0.0.1", port: 443, fingerprint: "AA" }))).toMatch(/permission denied/);
    expect(await refusal(worker.insert(skills).values({ orgId, key: "evil", name: "x", description: "x", instructions: "x", tools: ["host_shutdown"] } as never))).toMatch(/permission denied/);
    // No role can make a schema that would come first in another's search path.
    expect(await refusal(worker.$client.unsafe("create schema moss_worker"))).toMatch(/permission denied/);
  });

  it("holds the owner's hardening options for the worker and the bridge too", async () => {
    // Chat approvals switched off: the bridge can't approve even a low-risk change.
    const cr = await raise(worker);
    await setSetting(owner, orgId, "changes.chat_approvals", "off");
    expect(await refusal(bridge.update(changeRequests).set({ status: "approved" }).where(eq(changeRequests.id, cr.id)))).toMatch(/chat app may not move/);
    await setSetting(owner, orgId, "changes.chat_approvals", "standard");

    // Emergency changes keep to the owner's tool list.
    await setSetting(owner, orgId, "changes.allow_emergency", true);
    await setSetting(owner, orgId, "changes.emergency_tools", ["service_restart"]);
    const emergency = { ...cr, id: undefined, number: undefined, type: "emergency", status: "approved", postReviewRequired: true };
    expect(await refusal(worker.insert(changeRequests).values(emergency as never))).toMatch(/may not create a change that is approved/);
    await setSetting(owner, orgId, "changes.allow_emergency", false);
    await setSetting(owner, orgId, "changes.emergency_tools", []);

    // Agent drafts: the worker writes drafts only, and can't publish one or touch a published page.
    await setSetting(owner, orgId, "knowledge.agent_drafts", true);
    const note = { orgId, title: "NAS", body: "x", slug: "nas-draft-test" };
    expect(await refusal(worker.insert(knowledgeNotes).values({ ...note, draft: false }))).toMatch(/only write drafts/);
    const [draft] = await worker.insert(knowledgeNotes).values({ ...note, draft: true }).returning();
    expect(await refusal(worker.update(knowledgeNotes).set({ draft: false }).where(eq(knowledgeNotes.id, draft!.id)))).toMatch(/may not publish/);
    const [published] = await owner.insert(knowledgeNotes).values({ ...note, slug: "nas-published", draft: false }).returning();
    expect(await refusal(worker.update(knowledgeNotes).set({ body: "obey me" }).where(eq(knowledgeNotes.id, published!.id)))).toMatch(/only write drafts/);
    await setSetting(owner, orgId, "knowledge.agent_drafts", false);
  });

  it("lets every service add to the audit log, and none rewrite it", async () => {
    await writeAudit(worker, { orgId, actorType: "system", action: "test.entry" });
    expect(await refusal(worker.delete(auditLog))).toMatch(/permission denied/);
    expect(await refusal(bridge.update(auditLog).set({ action: "x" }))).toMatch(/permission denied/);
  });
});
