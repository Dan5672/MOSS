// Agent tools for incidents and change management. Agents never call write tools directly:
// change_execute runs exactly the approved plan, call by call, through the gate.
import {
  addChangeComment,
  BUILT_IN_TOOLS,
  addIncidentComment,
  assertCanExecute,
  changeRef,
  completeChange,
  createChangeRequest,
  createIncident,
  getChange,
  getIncident,
  incidentRef,
  listIncidents,
  markVerifying,
  recordExecution,
  requestAccess,
  startChange,
  updateIncident,
} from "@moss/core";
import { z } from "zod";
import type { PlatformTool } from "./platform-tools.js";

const plannedCall = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
});

const priority = z.enum(["P1", "P2", "P3", "P4"]).describe("P1 critical outage/active security issue, P2 major, P3 minor, P4 cosmetic/request");

function summarizeChange(c: NonNullable<Awaited<ReturnType<typeof getChange>>>) {
  return {
    id: c.id,
    ref: changeRef(c.number),
    type: c.type,
    status: c.status,
    title: c.title,
    risk: c.risk,
    plannedCalls: c.plannedCalls,
    rollbackCalls: c.rollbackCalls,
    verificationPlan: c.verificationPlan,
    rollbackPlan: c.rollbackPlan,
    window: c.windowStart ? { start: c.windowStart.toISOString(), end: c.windowEnd?.toISOString() ?? null } : null,
    incidentId: c.incidentId,
    notes: c.notes.map((n) => `[${n.kind}] ${n.body}`),
  };
}

export const TICKET_TOOLS: PlatformTool[] = [
  {
    name: "incident_create",
    description: "Raise an incident for something broken (break_fix), a security problem (security), or a request. Link affected assets.",
    permission: "incidents.manage",
    args: z.object({
      type: z.enum(["break_fix", "security", "request"]),
      title: z.string().min(3).max(200),
      description: z.string().max(5000),
      priority,
      assetIds: z.array(z.uuid()).max(20).optional(),
    }),
    run: async ({ db, orgId, agentId }, args) => {
      const inc = await createIncident(db, orgId, args, { type: "agent", id: agentId });
      return { id: inc.id, ref: incidentRef(inc.number), status: inc.status };
    },
  },
  {
    name: "incident_get",
    description: "Read an incident with its comments and linked assets.",
    permission: "incidents.read",
    args: z.object({ incidentId: z.uuid() }),
    run: async ({ db, orgId }, { incidentId }) => {
      const inc = await getIncident(db, orgId, incidentId);
      if (!inc) throw new Error("Incident not found");
      return {
        id: inc.id,
        ref: incidentRef(inc.number),
        type: inc.type,
        status: inc.status,
        priority: inc.priority,
        title: inc.title,
        description: inc.description,
        assets: inc.assets,
        comments: inc.comments.map((c) => ({ at: c.createdAt.toISOString(), by: c.authorAgentId ? "agent" : c.authorUserId ? "user" : "system", body: c.body })),
      };
    },
  },
  {
    name: "incident_list",
    description: "List open incidents, optionally only those assigned to you.",
    permission: "incidents.read",
    args: z.object({ assignedToMe: z.boolean().default(false), includeResolved: z.boolean().default(false) }),
    run: async ({ db, orgId, agentId }, args) =>
      (
        await listIncidents(db, orgId, {
          status: args.includeResolved ? undefined : ["new", "in_progress", "on_hold"],
          assignedAgentId: args.assignedToMe ? agentId : undefined,
        })
      ).map((i) => ({ id: i.id, ref: incidentRef(i.number), priority: i.priority, status: i.status, type: i.type, title: i.title })),
  },
  {
    name: "incident_update",
    description: "Change an incident's status or priority, with a note explaining why. Resolve it when the problem is fixed and verified.",
    permission: "incidents.manage",
    args: z.object({
      incidentId: z.uuid(),
      status: z.enum(["in_progress", "on_hold", "resolved"]).optional(),
      priority: priority.optional(),
      note: z.string().min(1).max(5000),
    }),
    run: async ({ db, orgId, agentId }, { incidentId, ...update }) => {
      const inc = await updateIncident(db, orgId, incidentId, update, { type: "agent", id: agentId });
      return { ref: incidentRef(inc.number), status: inc.status, priority: inc.priority };
    },
  },
  {
    name: "incident_comment",
    description: "Add a comment to an incident (findings, progress, questions for the owner).",
    permission: "incidents.manage",
    args: z.object({ incidentId: z.uuid(), body: z.string().min(1).max(5000) }),
    run: async ({ db, orgId, agentId }, { incidentId, body }) => {
      await addIncidentComment(db, orgId, incidentId, body, { type: "agent", id: agentId });
      return { ok: true };
    },
  },
  {
    name: "change_request_create",
    description:
      "Raise a change request. Every action that changes a system needs one. List the exact tool calls (plannedCalls) that " +
      "make the change and, where possible, the calls that undo it (rollbackCalls). Normal changes wait for a human approver; " +
      "standard changes use a pre-approved template (give standardTemplateKey and templateParams instead of plannedCalls); " +
      "emergency changes are only for active outages and may be disabled.",
    permission: "changes.create",
    args: z.object({
      type: z.enum(["normal", "standard", "emergency"]),
      title: z.string().min(3).max(200),
      description: z.string().min(1).max(5000).describe("What will change and why"),
      risk: z.enum(["low", "medium", "high"]).default("medium"),
      plannedCalls: z.array(plannedCall).max(20).default([]),
      rollbackCalls: z.array(plannedCall).max(20).default([]),
      rollbackPlan: z.string().min(1).max(2000),
      verificationPlan: z.string().min(1).max(2000).describe("How you will confirm the change worked"),
      standardTemplateKey: z.string().max(64).optional(),
      templateParams: z.record(z.string(), z.string().max(200)).optional(),
      incidentId: z.uuid().optional(),
      assetIds: z.array(z.uuid()).max(20).optional(),
    }),
    run: async ({ db, orgId, agentId }, args) => {
      const cr = await createChangeRequest(db, orgId, args, { type: "agent", id: agentId });
      return {
        id: cr.id,
        ref: changeRef(cr.number),
        status: cr.status,
        next:
          cr.status === "approved"
            ? "Approved. Run change_execute when ready."
            : "Waiting for a human approver. You will be given a new task when it is approved or rejected.",
      };
    },
  },
  {
    name: "access_request",
    description:
      "Ask for access you don't have: tools (by name) and secrets (by name). It raises a change request; nothing runs, and " +
      "when a person approves it you get exactly that access and a new task to carry on. Say why you need it.",
    permission: "changes.create",
    args: z.object({
      tools: z.array(z.string().min(1).max(64)).max(10).default([]),
      secrets: z.array(z.string().min(1).max(100)).max(5).default([]).describe("Secret names, e.g. unifi-password"),
      reason: z.string().min(1).max(2000).describe("What you need it for"),
      incidentId: z.uuid().optional(),
    }),
    run: async ({ db, orgId, agentId }, args) => {
      // Imported here: platform-tools.ts imports this file.
      const { PLATFORM_TOOLS } = await import("./platform-tools.js");
      const known = new Set([...BUILT_IN_TOOLS.keys(), ...PLATFORM_TOOLS.map((t) => t.name)]);
      const cr = await requestAccess(db, orgId, agentId, args, known);
      return { id: cr.id, ref: changeRef(cr.number), next: "Waiting for a person to approve it. You'll be given a new task when it's decided." };
    },
  },
  {
    name: "change_comment",
    description: "Add a comment to a change request: answer a question about it, or report progress.",
    permission: "changes.create",
    args: z.object({ changeId: z.uuid(), body: z.string().min(1).max(5000) }),
    run: async ({ db, orgId, agentId }, { changeId, body }) => {
      await addChangeComment(db, orgId, changeId, body, { type: "agent", id: agentId });
      return { ok: true };
    },
  },
  {
    name: "change_get",
    description: "Read a change request: status, planned and rollback calls, and its timeline.",
    permission: "changes.read",
    args: z.object({ changeId: z.uuid() }),
    run: async ({ db, orgId }, { changeId }) => {
      const c = await getChange(db, orgId, changeId);
      if (!c) throw new Error("Change not found");
      return summarizeChange(c);
    },
  },
  {
    name: "change_execute",
    description:
      "Execute an approved change you raised: runs its planned calls in order through the policy gate and stops at the first failure. " +
      "Afterwards, verify the result and call change_complete, or change_rollback if it went wrong.",
    permission: "changes.create",
    args: z.object({ changeId: z.uuid() }),
    run: async ({ db, orgId, agentId, gate, runId }, { changeId }) => {
      const actor = { type: "agent" as const, id: agentId };
      const change = await assertCanExecute(db, orgId, changeId, actor);
      if (change.status === "approved") await startChange(db, orgId, changeId, actor);
      else if (change.status !== "in_progress") throw new Error(`${changeRef(change.number)} is ${change.status}; only approved changes can be executed`);

      const results = [];
      for (const [i, call] of change.plannedCalls.entries()) {
        const res = await gate.callTool({ agentId, tool: call.tool, args: call.args, changeId, runId });
        const ok = res.allowed && res.ok;
        const summary = !res.allowed ? `denied: ${res.reason}` : res.ok ? "ok" : `failed: ${res.error}`;
        await recordExecution(db, changeId, actor, `Step ${i + 1} ${call.tool}: ${summary}`, { call, response: res });
        results.push({ step: i + 1, tool: call.tool, ok, result: res.allowed ? (res.ok ? res.result : res.error) : res.reason });
        if (!ok) {
          return {
            ref: changeRef(change.number),
            status: "in_progress",
            results,
            next: "A step failed and execution stopped. Investigate, then use change_rollback or change_complete with outcome failed.",
          };
        }
      }
      await markVerifying(db, orgId, changeId, actor);
      return { ref: changeRef(change.number), status: "verifying", results, next: `All steps ran. Verify: ${change.verificationPlan}` };
    },
  },
  {
    name: "change_rollback",
    description: "Run a change's rollback calls through the gate and mark it rolled back.",
    permission: "changes.create",
    args: z.object({ changeId: z.uuid(), reason: z.string().min(1).max(2000) }),
    run: async ({ db, orgId, agentId, gate, runId }, { changeId, reason }) => {
      const actor = { type: "agent" as const, id: agentId };
      const change = await assertCanExecute(db, orgId, changeId, actor);
      const results = [];
      for (const [i, call] of change.rollbackCalls.entries()) {
        const res = await gate.callTool({ agentId, tool: call.tool, args: call.args, changeId, runId });
        const ok = res.allowed && res.ok;
        await recordExecution(db, changeId, actor, `Rollback step ${i + 1} ${call.tool}: ${ok ? "ok" : res.allowed ? `failed: ${res.error}` : `denied: ${res.reason}`}`, {
          call,
          response: res,
        });
        results.push({ step: i + 1, tool: call.tool, ok });
        if (!ok) {
          await completeChange(db, orgId, changeId, "failed", `Rollback failed at step ${i + 1}. ${reason}`, actor);
          return { status: "failed", results, next: "Rollback failed; raise or update an incident so a human can step in." };
        }
      }
      await completeChange(db, orgId, changeId, "rolled_back", reason, actor);
      return { status: "rolled_back", results };
    },
  },
  {
    name: "change_complete",
    description: "Close out a change you executed after verifying it: outcome succeeded or failed, with what you checked.",
    permission: "changes.create",
    args: z.object({ changeId: z.uuid(), outcome: z.enum(["succeeded", "failed"]), notes: z.string().min(1).max(5000) }),
    run: async ({ db, orgId, agentId }, { changeId, outcome, notes }) => {
      const c = await completeChange(db, orgId, changeId, outcome, notes, { type: "agent", id: agentId });
      return { ref: changeRef(c.number), status: c.status };
    },
  },
];
