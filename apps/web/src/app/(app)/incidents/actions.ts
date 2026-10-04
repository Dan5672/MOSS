"use server";

import { addIncidentComment, createIncident, updateIncident } from "@moss/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

const priority = z.enum(["P1", "P2", "P3", "P4"]);

/** "agent:<id>" | "user:<id>" | "" -> assignee fields. */
function parseAssignee(value: string | undefined) {
  if (!value) return { assignedUserId: null, assignedAgentId: null };
  const [kind, id] = value.split(":");
  const uuid = z.uuid().parse(id);
  return kind === "agent" ? { assignedUserId: null, assignedAgentId: uuid } : { assignedUserId: uuid, assignedAgentId: null };
}

export async function createIncidentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("incidents.manage");
    const f = formObject(form);
    const input = z
      .object({ type: z.enum(["break_fix", "security", "request"]), title: z.string().min(3).max(200), description: z.string().max(5000).optional(), priority })
      .parse(f);
    const inc = await createIncident(db(), user.orgId, { ...input, ...parseAssignee(f.assignee) }, { type: "user", id: user.id });
    redirect(`/incidents/${inc.id}`);
  });
}

export async function updateIncidentAction(incidentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("incidents.manage");
    const f = formObject(form);
    const input = z
      .object({ status: z.enum(["new", "in_progress", "on_hold", "resolved", "closed"]), priority, note: z.string().max(5000).optional() })
      .parse(f);
    await updateIncident(db(), user.orgId, incidentId, { ...input, ...parseAssignee(f.assignee) }, { type: "user", id: user.id });
    return "Incident updated.";
  });
}

export async function commentAction(incidentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("incidents.manage");
    const body = z.string().min(1, "Write a comment").max(5000).parse(form.get("body"));
    await addIncidentComment(db(), user.orgId, incidentId, body, { type: "user", id: user.id });
  });
}
