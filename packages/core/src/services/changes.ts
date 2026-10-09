// Change management (ITIL-style). Standard changes come from pre-approved templates and
// run immediately; normal changes need a human approver; emergency changes run at once
// (only if enabled) and are flagged for review afterwards.
import {
  agents,
  changeApprovals,
  changeAssets,
  changeNotes,
  changeRequests,
  customTools,
  incidentComments,
  incidents,
  standardChangeTemplates,
  type Database,
  type PlannedToolCall,
} from "@moss/db";
import { BUILT_IN_TOOLS, customToolDefinition, customToolSpecSchema, parseToolArgs, type ToolDefinition } from "@moss/tools";
import { and, asc, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { getSetting } from "../store/settings-store.js";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";
import { emitEvent } from "./events.js";
import { notifyPermission, userPermissions } from "./notifications.js";

export type ChangeStatus = (typeof changeRequests.$inferSelect)["status"];
export type ChangeRow = typeof changeRequests.$inferSelect;

export const changeRef = (n: number | null) => `CR-${n}`;

const TRANSITIONS: Partial<Record<ChangeStatus, ChangeStatus[]>> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "cancelled"],
  approved: ["in_progress", "cancelled"],
  in_progress: ["verifying", "failed", "rolled_back"],
  verifying: ["succeeded", "failed", "rolled_back"],
  failed: ["rolled_back"],
};

/** Changes that still occupy their assets (used for conflict detection). */
const ACTIVE_STATUSES: ChangeStatus[] = ["approved", "in_progress", "verifying"];

export class ChangeError extends Error {}

export interface ChangeOptions {
  tools?: ReadonlyMap<string, ToolDefinition>;
}

/** Validates each call against its tool schema and stores normalized args (defaults applied), which the gate matches exactly. */
export function normalizeCalls(calls: PlannedToolCall[], tools: ReadonlyMap<string, ToolDefinition> = BUILT_IN_TOOLS): PlannedToolCall[] {
  return calls.map((c, i) => {
    const def = tools.get(c.tool);
    if (!def) throw new ChangeError(`Planned call ${i + 1}: unknown tool ${c.tool}`);
    const parsed = parseToolArgs(def, c.args);
    if (!parsed.ok) throw new ChangeError(`Planned call ${i + 1} (${c.tool}): ${parsed.error}`);
    return { tool: c.tool, args: parsed.args };
  });
}

/** Every tool a change in this org can plan: the built-ins plus the org's enabled custom tools. */
export async function orgToolDefinitions(db: Database, orgId: string): Promise<ReadonlyMap<string, ToolDefinition>> {
  const rows = await db
    .select({ spec: customTools.spec })
    .from(customTools)
    .where(and(eq(customTools.orgId, orgId), eq(customTools.enabled, true)));
  const map = new Map(BUILT_IN_TOOLS);
  for (const row of rows) {
    const spec = customToolSpecSchema.safeParse(row.spec);
    if (spec.success && !map.has(spec.data.key)) map.set(spec.data.key, customToolDefinition(spec.data));
  }
  return map;
}

/** Fills a standard template's "{param}" placeholders. Each param must fully match its regex. */
export function instantiateTemplate(
  template: { key: string; calls: { tool: string; args: Record<string, unknown> }[]; params: Record<string, string> },
  params: Record<string, string>,
): PlannedToolCall[] {
  for (const [name, pattern] of Object.entries(template.params)) {
    const value = params[name];
    if (value === undefined) throw new ChangeError(`Template ${template.key} needs parameter "${name}"`);
    if (!new RegExp(`^(?:${pattern})$`).test(value)) throw new ChangeError(`Parameter "${name}" does not match ${pattern}`);
  }
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\{(\w+)\}$/.exec(v);
      if (whole) return params[whole[1]!] ?? v;
      return v.replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m);
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const extra = Object.keys(params).filter((p) => !(p in template.params));
  if (extra.length) throw new ChangeError(`Unknown template parameters: ${extra.join(", ")}`);
  return template.calls.map((c) => ({ tool: c.tool, args: fill(c.args) as Record<string, unknown> }));
}

export interface NewChange {
  type: "standard" | "normal" | "emergency";
  title: string;
  description: string;
  risk?: "low" | "medium" | "high";
  plannedCalls?: PlannedToolCall[];
  rollbackCalls?: PlannedToolCall[];
  rollbackPlan: string;
  verificationPlan: string;
  standardTemplateKey?: string;
  templateParams?: Record<string, string>;
  incidentId?: string;
  assetIds?: string[];
  windowStart?: Date;
  windowEnd?: Date;
  /**
   * The agent that carries the change out: one MOSS raises itself (e.g. the Home Assistant module's
   * self-heal), or one a person raises and hands to an agent.
   */
  forAgentId?: string;
  /** A person carries it out by hand: no tool calls, and they record the result themselves. */
  manual?: boolean;
}

export async function createChangeRequest(db: Database, orgId: string, input: NewChange, actor: Actor, opts: ChangeOptions = {}) {
  if (input.windowStart && input.windowEnd && input.windowEnd <= input.windowStart) throw new ChangeError("The window must end after it starts");
  if (input.forAgentId && actor.type === "agent") throw new ChangeError("Agents raise changes for themselves");
  if (input.manual && (actor.type !== "user" || input.forAgentId || input.type === "standard")) {
    throw new ChangeError("Only a person can raise a change to carry out by hand, and not as a standard change");
  }
  if (input.forAgentId) {
    const [agent] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.id, input.forAgentId), eq(agents.orgId, orgId)));
    if (!agent || agent.status === "fired") throw new ChangeError("That agent can't carry out changes");
  }

  let planned = input.plannedCalls ?? [];
  let risk = input.risk ?? "medium";
  if (input.type === "standard") {
    if (!input.standardTemplateKey) throw new ChangeError("Standard changes must use a standard change template");
    const [template] = await db
      .select()
      .from(standardChangeTemplates)
      .where(and(eq(standardChangeTemplates.orgId, orgId), eq(standardChangeTemplates.key, input.standardTemplateKey), eq(standardChangeTemplates.enabled, true)));
    if (!template) throw new ChangeError(`No enabled standard change template ${input.standardTemplateKey}`);
    // The plan comes only from the template; anything else would bypass approval.
    planned = instantiateTemplate(template, input.templateParams ?? {});
    risk = template.risk;
  }
  if (input.manual) planned = [];
  else if (planned.length === 0) throw new ChangeError("A change needs at least one planned tool call (or carry it out by hand)");
  const tools = opts.tools ?? (await orgToolDefinitions(db, orgId));
  const plannedCalls = normalizeCalls(planned, tools);
  const rollbackCalls = normalizeCalls(input.rollbackCalls ?? [], tools);

  let status: ChangeStatus = "submitted";
  let postReviewRequired = false;
  if (input.type === "standard") status = "approved";
  if (input.type === "emergency") {
    if (!(await getSetting(db, orgId, "changes.allow_emergency"))) {
      throw new ChangeError("Emergency changes are disabled in settings; raise a normal change for approval");
    }
    status = "approved";
    postReviewRequired = true;
  }

  const change = await db.transaction(async (tx) => {
    if (input.incidentId) {
      const [inc] = await tx.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, input.incidentId), eq(incidents.orgId, orgId)));
      if (!inc) throw new ChangeError("Linked incident not found");
    }
    const [row] = await tx
      .insert(changeRequests)
      .values({
        orgId,
        type: input.type,
        status,
        title: input.title,
        description: input.description,
        risk,
        plannedCalls,
        rollbackCalls,
        rollbackPlan: input.rollbackPlan,
        verificationPlan: input.verificationPlan,
        standardTemplateKey: input.standardTemplateKey ?? null,
        incidentId: input.incidentId ?? null,
        requestedByUserId: actor.type === "user" ? actor.id : null,
        requestedByAgentId: actor.type === "agent" ? actor.id : (input.forAgentId ?? null),
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        postReviewRequired,
      })
      .returning();
    const change = row!;
    if (input.assetIds?.length) {
      await tx.insert(changeAssets).values([...new Set(input.assetIds)].map((assetId) => ({ changeId: change.id, assetId })));
    }
    const ref = changeRef(change.number);
    await tx.insert(changeNotes).values({
      changeId: change.id,
      kind: "system",
      body:
        status === "approved"
          ? input.type === "standard"
            ? `Pre-approved standard change (${input.standardTemplateKey}).`
            : "Emergency change: approved automatically, review required afterwards."
          : "Submitted for approval.",
    });
    if (input.incidentId) {
      await tx.insert(incidentComments).values({ incidentId: input.incidentId, body: `${ref} raised: ${input.title}` });
    }
    if (status === "approved") {
      await emitEvent(tx, orgId, { type: "change.approved", payload: { changeId: change.id } });
    } else {
      await emitEvent(tx, orgId, { type: "change.submitted", payload: { changeId: change.id } });
    }
    if (status === "submitted" || postReviewRequired) {
      await notifyPermission(tx, orgId, "changes.approve", {
        kind: "change",
        title: postReviewRequired ? `Emergency change ${ref} needs review: ${input.title}` : `${ref} needs approval: ${input.title}`,
        body: input.description.slice(0, 500),
        link: `/changes/${change.id}`,
      });
    }
    return change;
  });
  await writeAudit(db, {
    orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: "change.create",
    targetType: "change",
    targetId: change.id,
    details: { type: input.type, status, plannedCalls, rollbackCalls },
  });
  return change;
}

async function loadChange(db: Pick<Database, "select">, orgId: string, changeId: string): Promise<ChangeRow> {
  const [change] = await db.select().from(changeRequests).where(and(eq(changeRequests.id, changeId), eq(changeRequests.orgId, orgId)));
  if (!change) throw new ChangeError("Change not found");
  return change;
}

function assertTransition(change: ChangeRow, to: ChangeStatus) {
  if (!TRANSITIONS[change.status]?.includes(to)) {
    throw new ChangeError(`${changeRef(change.number)} is ${change.status} and can't move to ${to}`);
  }
}

/** Other active changes touching the same assets in an overlapping window (no window = open-ended). */
export async function findConflicts(db: Database, change: ChangeRow) {
  const assetRows = await db.select({ assetId: changeAssets.assetId }).from(changeAssets).where(eq(changeAssets.changeId, change.id));
  if (assetRows.length === 0) return [];
  const others = await db
    .selectDistinct({ change: changeRequests })
    .from(changeAssets)
    .innerJoin(changeRequests, eq(changeAssets.changeId, changeRequests.id))
    .where(
      and(
        inArray(
          changeAssets.assetId,
          assetRows.map((a) => a.assetId),
        ),
        ne(changeRequests.id, change.id),
        inArray(changeRequests.status, ACTIVE_STATUSES),
      ),
    );
  const start = change.windowStart?.getTime() ?? -Infinity;
  const end = change.windowEnd?.getTime() ?? Infinity;
  return others
    .map((o) => o.change)
    .filter((o) => (o.windowStart?.getTime() ?? -Infinity) < end && start < (o.windowEnd?.getTime() ?? Infinity));
}

async function recordDecision(
  db: Database,
  orgId: string,
  changeId: string,
  userId: string,
  decision: "approved" | "rejected",
  comment?: string,
  force = false,
) {
  const perms = await userPermissions(db, userId);
  if (!perms.has("changes.approve")) throw new ChangeError("You don't have permission to approve changes");
  const change = await loadChange(db, orgId, changeId);
  assertTransition(change, decision);
  if (change.requestedByUserId === userId && (await getSetting(db, orgId, "changes.require_separate_approver"))) {
    throw new ChangeError("Changes must be approved by someone other than the requester");
  }
  if (decision === "approved" && !force) {
    const conflicts = await findConflicts(db, change);
    if (conflicts.length) {
      throw new ChangeError(`Conflicts with ${conflicts.map((c) => changeRef(c.number)).join(", ")} on the same assets; approve with force to override`);
    }
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(changeRequests).set({ status: decision, updatedAt: new Date() }).where(eq(changeRequests.id, changeId)).returning();
    await tx.insert(changeApprovals).values({ changeId, userId, decision, comment: comment ?? null });
    await tx.insert(changeNotes).values({ changeId, authorUserId: userId, kind: "system", body: `${decision === "approved" ? "Approved" : "Rejected"}${comment ? `: ${comment}` : "."}` });
    await emitEvent(tx, orgId, { type: decision === "approved" ? "change.approved" : "change.rejected", payload: { changeId } });
    return row!;
  });
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: `change.${decision === "approved" ? "approve" : "reject"}`, targetType: "change", targetId: changeId, details: { comment, force } });
  return updated;
}

/** Human-only: agents can never approve or reject (they don't hold changes.approve). */
export const approveChange = (db: Database, orgId: string, changeId: string, userId: string, opts: { comment?: string; force?: boolean } = {}) =>
  recordDecision(db, orgId, changeId, userId, "approved", opts.comment, opts.force);

export const rejectChange = (db: Database, orgId: string, changeId: string, userId: string, comment?: string) =>
  recordDecision(db, orgId, changeId, userId, "rejected", comment);

async function transition(db: Database, orgId: string, changeId: string, to: ChangeStatus, actor: Actor, note: { kind: "system" | "execution"; body: string; data?: Record<string, unknown> }) {
  const change = await loadChange(db, orgId, changeId);
  assertTransition(change, to);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(changeRequests).set({ status: to, updatedAt: new Date() }).where(eq(changeRequests.id, changeId)).returning();
    await tx.insert(changeNotes).values({
      changeId,
      authorUserId: actor.type === "user" ? actor.id : null,
      authorAgentId: actor.type === "agent" ? actor.id : null,
      kind: note.kind,
      body: note.body,
      data: note.data ?? {},
    });
    if (to === "succeeded" || to === "failed" || to === "rolled_back") {
      await emitEvent(tx, orgId, { type: "change.completed", payload: { changeId, outcome: to } });
      if (change.incidentId) {
        await tx.insert(incidentComments).values({ incidentId: change.incidentId, body: `${changeRef(change.number)} finished: ${to.replace("_", " ")}.` });
      }
    }
    return row!;
  });
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: `change.${to}`, targetType: "change", targetId: changeId, details: { note: note.body } });
  return updated;
}

/** Only the requesting agent may execute an agent-raised change; users with changes.create may execute any. */
export async function assertCanExecute(db: Database, orgId: string, changeId: string, actor: Actor) {
  const change = await loadChange(db, orgId, changeId);
  if (actor.type === "agent" && change.requestedByAgentId !== actor.id) {
    throw new ChangeError(`${changeRef(change.number)} was not raised by you`);
  }
  return change;
}

export async function startChange(db: Database, orgId: string, changeId: string, actor: Actor) {
  await assertCanExecute(db, orgId, changeId, actor);
  return transition(db, orgId, changeId, "in_progress", actor, { kind: "system", body: "Execution started." });
}

export async function recordExecution(db: Database, changeId: string, actor: Actor, body: string, data: Record<string, unknown>) {
  await db.insert(changeNotes).values({
    changeId,
    authorUserId: actor.type === "user" ? actor.id : null,
    authorAgentId: actor.type === "agent" ? actor.id : null,
    kind: "execution",
    body,
    data,
  });
}

export async function markVerifying(db: Database, orgId: string, changeId: string, actor: Actor) {
  return transition(db, orgId, changeId, "verifying", actor, { kind: "system", body: "Planned calls executed; verifying." });
}

export async function completeChange(
  db: Database,
  orgId: string,
  changeId: string,
  outcome: "succeeded" | "failed" | "rolled_back",
  notes: string,
  actor: Actor,
) {
  await assertCanExecute(db, orgId, changeId, actor);
  return transition(db, orgId, changeId, outcome, actor, { kind: "system", body: notes || outcome });
}

/** A change carried out by hand: no tool calls, raised by a person. */
export const isManualChange = (c: Pick<ChangeRow, "plannedCalls" | "requestedByAgentId" | "requestedByUserId">) =>
  c.plannedCalls.length === 0 && !c.requestedByAgentId && !!c.requestedByUserId;

/** A person records how a by-hand change went, from approved (or in progress) to its outcome. */
export async function recordManualResult(db: Database, orgId: string, changeId: string, outcome: "succeeded" | "failed", notes: string, actor: Actor) {
  if (actor.type !== "user") throw new ChangeError("Only a person records the result of a change carried out by hand");
  const change = await loadChange(db, orgId, changeId);
  if (!isManualChange(change)) throw new ChangeError(`${changeRef(change.number)} is carried out by an agent, not by hand`);
  if (change.status === "approved") await startChange(db, orgId, changeId, actor);
  if (outcome === "succeeded") {
    if (change.status !== "verifying") await markVerifying(db, orgId, changeId, actor);
    return completeChange(db, orgId, changeId, "succeeded", notes, actor);
  }
  return completeChange(db, orgId, changeId, "failed", notes, actor);
}

export async function cancelChange(db: Database, orgId: string, changeId: string, actor: Actor, reason?: string) {
  const change = await loadChange(db, orgId, changeId);
  if (actor.type === "agent" && change.requestedByAgentId !== actor.id) throw new ChangeError("Agents can only cancel their own changes");
  return transition(db, orgId, changeId, "cancelled", actor, { kind: "system", body: `Cancelled${reason ? `: ${reason}` : "."}` });
}

export async function addChangeComment(db: Database, orgId: string, changeId: string, body: string, actor: Actor) {
  await loadChange(db, orgId, changeId);
  return db.transaction(async (tx) => {
    const [note] = await tx
      .insert(changeNotes)
      .values({
        changeId,
        authorUserId: actor.type === "user" ? actor.id : null,
        authorAgentId: actor.type === "agent" ? actor.id : null,
        kind: "comment",
        body,
      })
      .returning();
    // As with incidents: a person's comment reaches the agent carrying out the change.
    if (actor.type === "user") await emitEvent(tx, orgId, { type: "change.commented", payload: { changeId, noteId: note!.id } });
    return note!;
  });
}

export async function getChange(db: Database, orgId: string, changeId: string) {
  const [change] = await db.select().from(changeRequests).where(and(eq(changeRequests.id, changeId), eq(changeRequests.orgId, orgId)));
  if (!change) return null;
  const [notes, approvals, assetRows] = await Promise.all([
    db.select().from(changeNotes).where(eq(changeNotes.changeId, changeId)).orderBy(asc(changeNotes.createdAt)),
    db.select().from(changeApprovals).where(eq(changeApprovals.changeId, changeId)).orderBy(asc(changeApprovals.createdAt)),
    db.select({ assetId: changeAssets.assetId }).from(changeAssets).where(eq(changeAssets.changeId, changeId)),
  ]);
  return { ...change, notes, approvals, assetIds: assetRows.map((a) => a.assetId) };
}

export async function listChanges(db: Database, orgId: string, filter: { status?: ChangeStatus[]; requestedByAgentId?: string; limit?: number } = {}) {
  const where: SQL[] = [eq(changeRequests.orgId, orgId)];
  if (filter.status?.length) where.push(inArray(changeRequests.status, filter.status));
  if (filter.requestedByAgentId) where.push(eq(changeRequests.requestedByAgentId, filter.requestedByAgentId));
  return db.select().from(changeRequests).where(and(...where)).orderBy(desc(changeRequests.createdAt)).limit(Math.min(filter.limit ?? 50, 200));
}

export async function upsertStandardTemplate(
  db: Database,
  orgId: string,
  t: { key: string; name: string; description: string; risk?: "low" | "medium" | "high"; calls: { tool: string; args: Record<string, unknown> }[]; params: Record<string, string> },
  userId: string,
) {
  // Defining a standard change pre-approves it, so it takes the same permission as approving.
  if (!(await userPermissions(db, userId)).has("changes.approve")) throw new ChangeError("You don't have permission to define standard changes");
  for (const pattern of Object.values(t.params)) new RegExp(pattern); // throws on an invalid regex
  const values = { name: t.name, description: t.description, risk: t.risk ?? "low", calls: t.calls, params: t.params, enabled: true, updatedAt: new Date() };
  const [row] = await db
    .insert(standardChangeTemplates)
    .values({ orgId, key: t.key, ...values })
    .onConflictDoUpdate({ target: [standardChangeTemplates.orgId, standardChangeTemplates.key], set: values })
    .returning();
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "change_template.upsert", targetType: "standard_change_template", targetId: row!.id, details: t });
  return row!;
}
