// Incidents, change management and the event outbox against Postgres.
import { agents, assets, events, incidentComments, models, notifications, providers, roles, secretGrants, secrets, userRoles, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { BUILT_IN_TOOLS, type ToolDefinition } from "@moss/tools";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { hashPassword } from "./auth/password.js";
import {
  approveChange,
  completeChange,
  createChangeRequest,
  getChange,
  instantiateTemplate,
  markVerifying,
  recordManualResult,
  rejectChange,
  requestAccess,
  startChange,
  upsertStandardTemplate,
} from "./services/changes.js";
import { dispatchEvents } from "./services/events.js";
import { agentToolGrants } from "./services/tool-grants.js";
import { addIncidentComment, createIncident, getIncident, updateIncident } from "./services/incidents.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { setSetting } from "./store/settings-store.js";

const restart: ToolDefinition = {
  manifest: { name: "restart_service", class: "write", targetArgs: ["host"] },
  description: "test",
  args: z.object({ host: z.string(), service: z.string(), graceful: z.boolean().default(true) }).strict(),
};
const TOOLS = new Map<string, ToolDefinition>([...BUILT_IN_TOOLS, ["restart_service", restart]]);
const opts = { tools: TOOLS };

const base = {
  title: "Restart dnsmasq",
  description: "DNS resolution is failing on the LAN",
  rollbackPlan: "Nothing to roll back; restart is idempotent",
  verificationPlan: "dns_lookup router.lan returns an address",
};

describe.skipIf(!TEST_DATABASE_URL)("incidents and changes (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;
  let viewerId: string;
  let agentId: string;
  let otherAgentId: string;
  let assetId: string;
  const agent = () => ({ type: "agent" as const, id: agentId });
  const owner = () => ({ type: "user" as const, id: ownerId });

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_tickets"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    ownerId = boot.owner.id;
    const [viewer] = await db.insert(users).values({ orgId, email: "v@h.test", displayName: "V", passwordHash: await hashPassword("a-long-test-password") }).returning();
    viewerId = viewer!.id;
    await db.insert(userRoles).values({ userId: viewerId, roleId: boot.roleIds.viewer! });
    const [p] = await db.insert(providers).values({ orgId, kind: "ollama", name: "L" }).returning();
    const [m] = await db.insert(models).values({ orgId, providerId: p!.id, modelId: "m", displayName: "M" }).returning();
    const [roleAgent] = await db.select().from(roles).where(eq(roles.key, "agent"));
    [{ id: agentId }, { id: otherAgentId }] = await db
      .insert(agents)
      .values([
        { orgId, name: "Sam", title: "Systems Admin", systemPrompt: "x", modelId: m!.id, roleId: roleAgent!.id },
        { orgId, name: "Nina", title: "Network Admin", systemPrompt: "x", modelId: m!.id, roleId: roleAgent!.id },
      ])
      .returning();
    [{ id: assetId }] = await db.insert(assets).values({ orgId, name: "router", source: "user" }).returning();
  });
  afterAll(() => close?.());

  describe("incidents", () => {
    it("creates a P1, notifies managers and emits events", async () => {
      const inc = await createIncident(db, orgId, { type: "break_fix", title: "DNS down", priority: "P1", assetIds: [assetId], assignedAgentId: agentId }, agent());
      expect(inc).toMatchObject({ status: "new", priority: "P1", raisedByAgentId: agentId, assignedAgentId: agentId });
      const n = await db.select().from(notifications).where(eq(notifications.userId, ownerId));
      expect(n.at(-1)).toMatchObject({ kind: "incident", title: `P1 INC-${inc.number}: DNS down` });
      expect(await db.select().from(notifications).where(eq(notifications.userId, viewerId))).toHaveLength(0);
      const types = (await db.select().from(events).orderBy(asc(events.id))).map((e) => e.type);
      expect(types).toEqual(["incident.created", "incident.assigned"]);
      expect((await getIncident(db, orgId, inc.id))!.assets.map((a) => a.id)).toEqual([assetId]);
    });

    it("enforces status transitions and only lets users reopen closed incidents", async () => {
      const inc = await createIncident(db, orgId, { type: "request", title: "Add printer" }, owner());
      await updateIncident(db, orgId, inc.id, { status: "in_progress", note: "Looking into it" }, agent());
      await expect(updateIncident(db, orgId, inc.id, { status: "new" }, agent())).rejects.toThrow(/can't go from in_progress to new/);
      const resolved = await updateIncident(db, orgId, inc.id, { status: "resolved" }, agent());
      expect(resolved.resolvedAt).toBeInstanceOf(Date);
      await updateIncident(db, orgId, inc.id, { status: "closed" }, owner());
      await expect(updateIncident(db, orgId, inc.id, { status: "in_progress" }, agent())).rejects.toThrow(/Only a user/);
      expect((await updateIncident(db, orgId, inc.id, { status: "in_progress" }, owner())).resolvedAt).toBeNull();
      await addIncidentComment(db, orgId, inc.id, "Printer added", agent());
      expect((await getIncident(db, orgId, inc.id))!.comments.map((c) => c.body)).toEqual(["Looking into it", "Printer added"]);
    });

    it("validates assignees", async () => {
      const inc = await createIncident(db, orgId, { type: "break_fix", title: "x" }, owner());
      await expect(updateIncident(db, orgId, inc.id, { assignedUserId: ownerId, assignedAgentId: agentId }, owner())).rejects.toThrow(/not both/);
      await expect(updateIncident(db, orgId, inc.id, { assignedAgentId: "00000000-0000-0000-0000-000000000000" }, owner())).rejects.toThrow(/Unknown/);
    });
  });

  describe("change management", () => {
    it("submits normal changes with normalized plans and notifies approvers", async () => {
      const inc = await createIncident(db, orgId, { type: "break_fix", title: "DNS broken" }, agent());
      const cr = await createChangeRequest(
        db,
        orgId,
        { ...base, type: "normal", incidentId: inc.id, assetIds: [assetId], plannedCalls: [{ tool: "restart_service", args: { host: "192.168.1.1", service: "dnsmasq" } }] },
        agent(),
        opts,
      );
      expect(cr).toMatchObject({ status: "submitted", requestedByAgentId: agentId, risk: "medium" });
      // Defaults are applied so the gate's exact match against validated arguments works.
      expect(cr.plannedCalls).toEqual([{ tool: "restart_service", args: { host: "192.168.1.1", service: "dnsmasq", graceful: true } }]);
      const comments = await db.select().from(incidentComments).where(eq(incidentComments.incidentId, inc.id));
      expect(comments.map((c) => c.body)).toEqual([`CR-${cr.number} raised: Restart dnsmasq`]);
      expect((await db.select().from(notifications).where(eq(notifications.kind, "change"))).at(-1)!.title).toBe(`CR-${cr.number} needs approval: Restart dnsmasq`);
    });

    it("rejects plans with unknown tools or invalid arguments", async () => {
      await expect(createChangeRequest(db, orgId, { ...base, type: "normal", plannedCalls: [{ tool: "rm_rf", args: {} }] }, agent(), opts)).rejects.toThrow(/unknown tool/);
      await expect(
        createChangeRequest(db, orgId, { ...base, type: "normal", plannedCalls: [{ tool: "restart_service", args: { host: "x", service: 5 } }] }, agent(), opts),
      ).rejects.toThrow(/restart_service/);
      await expect(createChangeRequest(db, orgId, { ...base, type: "normal", plannedCalls: [] }, agent(), opts)).rejects.toThrow(/at least one/);
    });

    it("lets only users with changes.approve decide", async () => {
      const cr = await createChangeRequest(db, orgId, { ...base, type: "normal", plannedCalls: [{ tool: "restart_service", args: { host: "10.0.0.1", service: "a" } }] }, agent(), opts);
      await expect(approveChange(db, orgId, cr.id, viewerId)).rejects.toThrow(/permission/);
      await expect(approveChange(db, orgId, cr.id, agentId)).rejects.toThrow(/permission/); // an agent id is not a user with roles
      const rejected = await rejectChange(db, orgId, cr.id, ownerId, "Not during the day");
      expect(rejected.status).toBe("rejected");
      await expect(approveChange(db, orgId, cr.id, ownerId)).rejects.toThrow(/rejected and can't move to approved/);
    });

    it("can require a separate approver", async () => {
      const cr = await createChangeRequest(db, orgId, { ...base, type: "normal", plannedCalls: [{ tool: "ping", args: { target: "10.0.0.1" } }] }, owner(), opts);
      await setSetting(db, orgId, "changes.require_separate_approver", true);
      await expect(approveChange(db, orgId, cr.id, ownerId)).rejects.toThrow(/someone other than the requester/);
      await setSetting(db, orgId, "changes.require_separate_approver", false);
      expect((await approveChange(db, orgId, cr.id, ownerId)).status).toBe("approved");
    });

    it("detects conflicting changes on the same asset", async () => {
      const mk = (start: string, end: string) =>
        createChangeRequest(
          db,
          orgId,
          { ...base, type: "normal", assetIds: [assetId], windowStart: new Date(start), windowEnd: new Date(end), plannedCalls: [{ tool: "restart_service", args: { host: "192.168.1.1", service: "x" } }] },
          agent(),
          opts,
        );
      const a = await mk("2026-11-01T01:00:00Z", "2026-11-01T02:00:00Z");
      const b = await mk("2026-11-01T01:30:00Z", "2026-11-01T03:00:00Z");
      const c = await mk("2026-11-02T01:00:00Z", "2026-11-02T02:00:00Z");
      await approveChange(db, orgId, a.id, ownerId);
      await expect(approveChange(db, orgId, b.id, ownerId)).rejects.toThrow(new RegExp(`Conflicts with CR-${a.number}`));
      expect((await approveChange(db, orgId, b.id, ownerId, { force: true })).status).toBe("approved");
      // The first test's open-ended submitted change isn't active, and c's window doesn't overlap.
      expect((await approveChange(db, orgId, c.id, ownerId)).status).toBe("approved");
    });

    it("only allows emergency changes when enabled, and flags them for review", async () => {
      const input = { ...base, type: "emergency" as const, plannedCalls: [{ tool: "restart_service", args: { host: "10.0.0.9", service: "x" } }] };
      await expect(createChangeRequest(db, orgId, input, agent(), opts)).rejects.toThrow(/Emergency changes are disabled/);
      await setSetting(db, orgId, "changes.allow_emergency", true);
      expect(await createChangeRequest(db, orgId, input, agent(), opts)).toMatchObject({ status: "approved", postReviewRequired: true });
      await setSetting(db, orgId, "changes.allow_emergency", false);
    });

    it("builds standard changes only from templates with validated parameters", async () => {
      await expect(
        upsertStandardTemplate(db, orgId, { key: "x", name: "x", description: "x", calls: [], params: {} }, viewerId),
      ).rejects.toThrow(/permission/);
      await upsertStandardTemplate(
        db,
        orgId,
        {
          key: "restart-dns",
          name: "Restart DNS",
          description: "Restart the DNS service on the router",
          calls: [{ tool: "restart_service", args: { host: "{host}", service: "dnsmasq" } }],
          params: { host: "192\\.168\\.1\\.\\d{1,3}" },
        },
        ownerId,
      );
      const cr = await createChangeRequest(
        db,
        orgId,
        // Planned calls supplied by the caller are ignored for standard changes.
        { ...base, type: "standard", standardTemplateKey: "restart-dns", templateParams: { host: "192.168.1.1" }, plannedCalls: [{ tool: "restart_service", args: { host: "10.0.0.1", service: "sshd" } }] },
        agent(),
        opts,
      );
      expect(cr).toMatchObject({ status: "approved", risk: "low" });
      expect(cr.plannedCalls).toEqual([{ tool: "restart_service", args: { host: "192.168.1.1", service: "dnsmasq", graceful: true } }]);
      await expect(
        createChangeRequest(db, orgId, { ...base, type: "standard", standardTemplateKey: "restart-dns", templateParams: { host: "192.168.1.1; reboot" } }, agent(), opts),
      ).rejects.toThrow(/does not match/);
      await expect(createChangeRequest(db, orgId, { ...base, type: "standard", standardTemplateKey: "nope" }, agent(), opts)).rejects.toThrow(/No enabled/);
    });

    it("instantiates templates without injecting into partial strings unsafely", () => {
      const t = { key: "t", calls: [{ tool: "a", args: { url: "http://{host}/x", list: ["{host}"] } }], params: { host: "[a-z]+" } };
      expect(instantiateTemplate(t, { host: "nas" })).toEqual([{ tool: "a", args: { url: "http://nas/x", list: ["nas"] } }]);
      expect(() => instantiateTemplate(t, { host: "nas", extra: "1" })).toThrow(/Unknown template parameters/);
      expect(() => instantiateTemplate(t, {})).toThrow(/needs parameter/);
    });

    it("runs the execution lifecycle and reports back to the incident", async () => {
      const inc = await createIncident(db, orgId, { type: "break_fix", title: "Service down" }, agent());
      const cr = await createChangeRequest(db, orgId, { ...base, type: "normal", incidentId: inc.id, plannedCalls: [{ tool: "restart_service", args: { host: "192.168.1.5", service: "web" } }] }, agent(), opts);
      await expect(startChange(db, orgId, cr.id, agent())).rejects.toThrow(/submitted and can't move to in_progress/);
      await approveChange(db, orgId, cr.id, ownerId);
      await expect(startChange(db, orgId, cr.id, { type: "agent", id: otherAgentId })).rejects.toThrow(/not raised by you/);
      await startChange(db, orgId, cr.id, agent());
      await markVerifying(db, orgId, cr.id, agent());
      const done = await completeChange(db, orgId, cr.id, "succeeded", "web responds on 80/tcp", agent());
      expect(done.status).toBe("succeeded");
      await expect(completeChange(db, orgId, cr.id, "failed", "x", agent())).rejects.toThrow(/succeeded and can't move/);

      const full = await getChange(db, orgId, cr.id);
      expect(full!.notes.map((n) => n.body)).toEqual(["Submitted for approval.", "Approved.", "Execution started.", "Planned calls executed; verifying.", "web responds on 80/tcp"]);
      expect((await getIncident(db, orgId, inc.id))!.comments.map((c) => c.body)).toEqual([`CR-${cr.number} raised: Restart dnsmasq`, `CR-${cr.number} finished: succeeded.`]);
    });
  });

  describe("incident/change consistency", () => {
    it("stops agents resolving an incident while a linked change is pending or failed", async () => {
      const inc = await createIncident(db, orgId, { type: "break_fix", title: "Host off" }, agent());
      const cr = await createChangeRequest(db, orgId, { ...base, type: "normal", incidentId: inc.id, plannedCalls: [{ tool: "restart_service", args: { host: "192.168.1.9", service: "x" } }] }, agent(), opts);
      await expect(updateIncident(db, orgId, inc.id, { status: "resolved", note: "fixed" }, agent())).rejects.toThrow(
        new RegExp(`CR-${cr.number} is submitted`),
      );

      await approveChange(db, orgId, cr.id, ownerId);
      await startChange(db, orgId, cr.id, agent());
      await markVerifying(db, orgId, cr.id, agent());
      await completeChange(db, orgId, cr.id, "failed", "Still down", agent());
      await expect(updateIncident(db, orgId, inc.id, { status: "resolved", note: "fixed" }, agent())).rejects.toThrow(/is failed/);

      // A human can still decide.
      expect((await updateIncident(db, orgId, inc.id, { status: "resolved", note: "Fixed by hand" }, owner())).status).toBe("resolved");
    });
  });

  describe("event outbox", () => {
    it("dispatches pending events once and retries failures", async () => {
      const seen: string[] = [];
      let failNext = true;
      const handled = await dispatchEvents(
        db,
        async (e) => {
          if (e.type === "change.approved" && failNext) {
            failNext = false;
            throw new Error("transient");
          }
          seen.push(e.type);
        },
        500,
      );
      expect(handled).toBeGreaterThan(5);
      const failed = (await db.select().from(events).orderBy(asc(events.id))).filter((e) => e.lastError);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ attempts: 1, processedAt: null, lastError: "transient" });

      // Not retried before its backoff expires; then picked up alone.
      expect(await dispatchEvents(db, async () => {}, 500)).toBe(0);
      await db.update(events).set({ availableAt: new Date() }).where(eq(events.id, failed[0]!.id));
      seen.length = 0;
      await dispatchEvents(db, async (e) => void seen.push(e.type), 500);
      expect(seen).toEqual(["change.approved"]);
      expect(await dispatchEvents(db, async () => {}, 500)).toBe(0);
    });
  });

  describe("changes people raise", () => {
    it("for an agent: the agent is the one told to run it once approved", async () => {
      const cr = await createChangeRequest(
        db,
        orgId,
        { type: "normal", ...base, plannedCalls: [{ tool: "restart_service", args: { host: "10.0.0.5", service: "dnsmasq" } }], forAgentId: agentId },
        owner(),
        opts,
      );
      expect(cr).toMatchObject({ status: "submitted", requestedByUserId: ownerId, requestedByAgentId: agentId });
      await expect(createChangeRequest(db, orgId, { type: "normal", ...base, plannedCalls: [], forAgentId: agentId }, owner(), opts)).rejects.toThrow(/at least one planned tool call/);
      await expect(createChangeRequest(db, orgId, { type: "normal", ...base, plannedCalls: [{ tool: "restart_service", args: { host: "x", service: "y" } }], forAgentId: otherAgentId }, agent(), opts)).rejects.toThrow(/for themselves/);
    });

    it("by hand: no tool calls, approved like any change, and the person records the result", async () => {
      const cr = await createChangeRequest(db, orgId, { type: "normal", ...base, title: "Replace the switch", manual: true }, owner(), opts);
      expect(cr).toMatchObject({ status: "submitted", plannedCalls: [], requestedByAgentId: null });
      await expect(recordManualResult(db, orgId, cr.id, "succeeded", "done", owner())).rejects.toThrow(/can't move/);
      await setSetting(db, orgId, "changes.require_separate_approver", false);
      await approveChange(db, orgId, cr.id, ownerId);
      await expect(recordManualResult(db, orgId, cr.id, "succeeded", "done", agent())).rejects.toThrow(/Only a person/);
      await recordManualResult(db, orgId, cr.id, "succeeded", "Swapped it; all ports up.", owner());
      expect((await getChange(db, orgId, cr.id))!.status).toBe("succeeded");
      await expect(createChangeRequest(db, orgId, { type: "normal", ...base, manual: true }, agent(), opts)).rejects.toThrow(/Only a person/);
    });
  });

  describe("@mentions", () => {
    it("stores who was mentioned and notifies the people (not the author)", async () => {
      const inc = await createIncident(db, orgId, { type: "request", title: "New printer" }, owner());
      const c = await addIncidentComment(db, orgId, inc.id, "@V can you approve the purchase? @O fyi", owner());
      expect(c.mentions).toEqual([{ type: "user", id: viewerId }, { type: "user", id: ownerId }]);
      const mine = await db.select().from(notifications).where(eq(notifications.userId, viewerId));
      expect(mine.find((n) => n.kind === "mention")).toMatchObject({ title: `O mentioned you on INC-${inc.number}`, link: `/incidents/${inc.id}` });
      expect((await db.select().from(notifications).where(eq(notifications.userId, ownerId))).some((n) => n.kind === "mention")).toBe(false);
    });
  });

  describe("access requests", () => {
    it("asks for tools and secrets through a change, and approving grants exactly that", async () => {
      const [secret] = await db
        .insert(secrets)
        .values({ orgId, name: "router-pw", type: "password", ciphertext: "x", wrappedDataKey: "y" })
        .returning();
      const known = new Set(["ping", "snmp_get"]);
      await expect(requestAccess(db, orgId, agentId, { tools: ["format_disk"], reason: "x" }, known)).rejects.toThrow(/No such tool/);
      await expect(requestAccess(db, orgId, agentId, { secrets: ["nope"], reason: "x" }, known)).rejects.toThrow(/No such secret/);

      const cr = await requestAccess(db, orgId, agentId, { tools: ["snmp_get"], secrets: ["secret:router-pw"], reason: "Read the router's interfaces" }, known);
      expect(cr).toMatchObject({ status: "submitted", plannedCalls: [], accessGrant: { tools: ["snmp_get"], secretIds: [secret!.id] } });
      expect(cr.title).toBe("Access for Sam: snmp_get, secret:router-pw");
      expect(await agentToolGrants(db, agentId)).not.toContain("snmp_get");

      const done = await approveChange(db, orgId, cr.id, ownerId);
      expect(done.status).toBe("succeeded");
      expect(await agentToolGrants(db, agentId)).toContain("snmp_get");
      expect(await db.select().from(secretGrants).where(eq(secretGrants.agentId, agentId))).toHaveLength(1);
      const evs = await db.select().from(events).where(eq(events.orgId, orgId));
      expect(evs.some((e) => e.type === "change.access_granted" && (e.payload as { changeId: string }).changeId === cr.id)).toBe(true);
      expect(evs.some((e) => e.type === "change.approved" && (e.payload as { changeId: string }).changeId === cr.id)).toBe(false);

      await expect(requestAccess(db, orgId, agentId, { tools: ["snmp_get"], secrets: ["router-pw"], reason: "again" }, known)).rejects.toThrow(/already have/);
      // A rejected request grants nothing.
      const other = await requestAccess(db, orgId, otherAgentId, { tools: ["ping"], reason: "x" }, known);
      await rejectChange(db, orgId, other.id, ownerId, "Not needed");
      expect(await agentToolGrants(db, otherAgentId)).not.toContain("ping");
    });
  });
});
