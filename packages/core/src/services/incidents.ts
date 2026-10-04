// Incidents: break/fix and security tickets, raised and worked by users or agents.
import { agents, assets, changeRequests, incidentAssets, incidentComments, incidents, users, type Database } from "@moss/db";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";
import { emitEvent } from "./events.js";
import { notifyPermission } from "./notifications.js";

export type IncidentStatus = (typeof incidents.$inferSelect)["status"];
export type Priority = "P1" | "P2" | "P3" | "P4";

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  new: ["in_progress", "on_hold", "resolved", "closed"],
  in_progress: ["on_hold", "resolved"],
  on_hold: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
};

export class InvalidTransitionError extends Error {}

/** Linked changes in these statuses block an agent from resolving the incident. */
const UNSETTLED_CHANGE_STATUSES: (typeof changeRequests.$inferSelect)["status"][] = ["submitted", "approved", "in_progress", "verifying", "failed"];

export const incidentRef = (n: number | null) => `INC-${n}`;

function authorFields(actor: Actor) {
  return {
    authorUserId: actor.type === "user" ? actor.id : null,
    authorAgentId: actor.type === "agent" ? actor.id : null,
  };
}

export interface NewIncident {
  type: "break_fix" | "security" | "request";
  title: string;
  description?: string;
  priority?: Priority;
  assetIds?: string[];
  assignedUserId?: string | null;
  assignedAgentId?: string | null;
}

async function assertAssignee(db: Pick<Database, "select">, orgId: string, userId?: string | null, agentId?: string | null) {
  if (userId && agentId) throw new Error("Assign to a user or an agent, not both");
  if (userId) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.orgId, orgId)));
    if (!u) throw new Error("Unknown user");
  }
  if (agentId) {
    const [a] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    if (!a || a.status === "fired") throw new Error("Unknown or fired agent");
  }
}

export async function createIncident(db: Database, orgId: string, input: NewIncident, actor: Actor) {
  await assertAssignee(db, orgId, input.assignedUserId, input.assignedAgentId);
  const priority = input.priority ?? "P3";
  const incident = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(incidents)
      .values({
        orgId,
        type: input.type,
        title: input.title,
        description: input.description ?? "",
        priority,
        raisedByUserId: actor.type === "user" ? actor.id : null,
        raisedByAgentId: actor.type === "agent" ? actor.id : null,
        assignedUserId: input.assignedUserId ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
      })
      .returning();
    if (input.assetIds?.length) {
      const owned = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.orgId, orgId), inArray(assets.id, input.assetIds)));
      if (owned.length) await tx.insert(incidentAssets).values(owned.map((a) => ({ incidentId: row!.id, assetId: a.id })));
    }
    await emitEvent(tx, orgId, { type: "incident.created", payload: { incidentId: row!.id, priority } });
    if (row!.assignedAgentId) await emitEvent(tx, orgId, { type: "incident.assigned", payload: { incidentId: row!.id, agentId: row!.assignedAgentId } });
    if (priority === "P1" || priority === "P2") {
      await notifyPermission(tx, orgId, "incidents.manage", {
        kind: "incident",
        title: `${priority} ${incidentRef(row!.number)}: ${input.title}`,
        body: input.description?.slice(0, 500),
        link: `/incidents/${row!.id}`,
      });
    }
    return row!;
  });
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "incident.create", targetType: "incident", targetId: incident.id, details: { priority, type: input.type, title: input.title } });
  return incident;
}

export async function getIncident(db: Database, orgId: string, incidentId: string) {
  const [incident] = await db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.orgId, orgId)));
  if (!incident) return null;
  const [comments, linkedAssets] = await Promise.all([
    db.select().from(incidentComments).where(eq(incidentComments.incidentId, incidentId)).orderBy(asc(incidentComments.createdAt)),
    db
      .select({ id: assets.id, name: assets.name, ip: assets.primaryIp, kind: assets.kind })
      .from(incidentAssets)
      .innerJoin(assets, eq(incidentAssets.assetId, assets.id))
      .where(eq(incidentAssets.incidentId, incidentId)),
  ]);
  return { ...incident, comments, assets: linkedAssets };
}

export async function listIncidents(
  db: Database,
  orgId: string,
  filter: { status?: IncidentStatus[]; assignedAgentId?: string; priority?: Priority; limit?: number } = {},
) {
  const where: SQL[] = [eq(incidents.orgId, orgId)];
  if (filter.status?.length) where.push(inArray(incidents.status, filter.status));
  if (filter.assignedAgentId) where.push(eq(incidents.assignedAgentId, filter.assignedAgentId));
  if (filter.priority) where.push(eq(incidents.priority, filter.priority));
  return db
    .select()
    .from(incidents)
    .where(and(...where))
    .orderBy(asc(incidents.priority), desc(incidents.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
}

export async function addIncidentComment(db: Database, orgId: string, incidentId: string, body: string, actor: Actor) {
  const [incident] = await db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.orgId, orgId)));
  if (!incident) throw new Error("Incident not found");
  const [comment] = await db.insert(incidentComments).values({ incidentId, body, ...authorFields(actor) }).returning();
  return comment!;
}

export interface IncidentUpdate {
  status?: IncidentStatus;
  priority?: Priority;
  /** null unassigns. */
  assignedUserId?: string | null;
  assignedAgentId?: string | null;
  note?: string;
}

export async function updateIncident(db: Database, orgId: string, incidentId: string, update: IncidentUpdate, actor: Actor) {
  const [incident] = await db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.orgId, orgId)));
  if (!incident) throw new Error("Incident not found");

  const set: Partial<typeof incidents.$inferInsert> = { updatedAt: new Date() };
  if (update.status && update.status !== incident.status) {
    if (!TRANSITIONS[incident.status].includes(update.status)) {
      throw new InvalidTransitionError(`An incident can't go from ${incident.status} to ${update.status}`);
    }
    if (incident.status === "closed" && actor.type !== "user") throw new InvalidTransitionError("Only a user can reopen a closed incident");
    if (actor.type === "agent" && (update.status === "resolved" || update.status === "closed")) {
      // An agent must not declare victory while its fix is unfinished or failed; a human can still override.
      const open = await db
        .select({ number: changeRequests.number, status: changeRequests.status })
        .from(changeRequests)
        .where(and(eq(changeRequests.incidentId, incidentId), inArray(changeRequests.status, UNSETTLED_CHANGE_STATUSES)));
      if (open.length) {
        throw new InvalidTransitionError(
          `${incidentRef(incident.number)} can't be resolved while ${open.map((c) => `CR-${c.number} is ${c.status}`).join(", ")}. ` +
            "Comment with what happened and leave it for a human, or roll the change back.",
        );
      }
    }
    set.status = update.status;
    set.resolvedAt = update.status === "resolved" || update.status === "closed" ? (incident.resolvedAt ?? new Date()) : null;
  }
  if (update.priority) set.priority = update.priority;
  const reassigning = update.assignedUserId !== undefined || update.assignedAgentId !== undefined;
  if (reassigning) {
    await assertAssignee(db, orgId, update.assignedUserId, update.assignedAgentId);
    set.assignedUserId = update.assignedUserId ?? null;
    set.assignedAgentId = update.assignedAgentId ?? null;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(incidents).set(set).where(eq(incidents.id, incidentId)).returning();
    if (update.note) await tx.insert(incidentComments).values({ incidentId, body: update.note, ...authorFields(actor) });
    if (reassigning && set.assignedAgentId && set.assignedAgentId !== incident.assignedAgentId) {
      await emitEvent(tx, orgId, { type: "incident.assigned", payload: { incidentId, agentId: set.assignedAgentId } });
    }
    return row!;
  });
  const { note: _, ...changes } = update;
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action: "incident.update", targetType: "incident", targetId: incidentId, details: changes });
  return updated;
}
