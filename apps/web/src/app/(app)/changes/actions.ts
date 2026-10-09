"use server";

import { addChangeComment, approveChange, cancelChange, createChangeRequest, recordManualResult, rejectChange } from "@moss/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

export async function approveAction(changeId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.approve");
    const f = formObject(form);
    await approveChange(db(), user.orgId, changeId, user.id, { comment: f.comment, force: f.force === "on" });
    return "Approved. The agent will be told to carry it out.";
  });
}

export async function rejectAction(changeId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.approve");
    const comment = z.string().min(1, "Say why, so the agent can explain it on the incident").max(2000).parse(form.get("comment"));
    await rejectChange(db(), user.orgId, changeId, user.id, comment);
    return "Rejected.";
  });
}

export async function cancelAction(changeId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.create");
    await cancelChange(db(), user.orgId, changeId, { type: "user", id: user.id });
    return "Cancelled.";
  });
}

export async function changeCommentAction(changeId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.create");
    const body = z.string().min(1).max(5000).parse(form.get("body"));
    await addChangeComment(db(), user.orgId, changeId, body, { type: "user", id: user.id });
  });
}

const changeSchema = z.object({
  title: z.string().trim().min(3, "Give the change a title").max(200),
  description: z.string().trim().min(1, "Say what the change is and why").max(5000),
  type: z.enum(["normal", "emergency"]),
  risk: z.enum(["low", "medium", "high"]),
  carriedOutBy: z.string().min(1),
  incidentId: z.uuid().optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  verificationPlan: z.string().trim().min(1, "Say how you'll check it worked").max(5000),
  rollbackPlan: z.string().trim().min(1, "Say how to undo it").max(5000),
  plannedCalls: z.string().optional(),
});

const when = (v: string | undefined) => {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("That window time isn't a date");
  return d;
};

/** A person raises a change: carried out by hand, or by an agent with the exact tool calls listed. */
export async function createChangeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.create");
    const f = changeSchema.parse(formObject(form));
    const byHand = f.carriedOutBy === "hand";
    let plannedCalls: { tool: string; args: Record<string, unknown> }[] = [];
    if (!byHand) {
      let raw: unknown;
      try {
        raw = JSON.parse(f.plannedCalls ?? "[]");
      } catch {
        throw new Error("The tool calls aren't valid JSON");
      }
      plannedCalls = z
        .array(z.object({ tool: z.string().min(1).max(64), args: z.record(z.string(), z.unknown(), { error: "Each call's arguments must be a JSON object" }) }))
        .max(20)
        .parse(raw);
    }
    const change = await createChangeRequest(
      db(),
      user.orgId,
      {
        type: f.type,
        title: f.title,
        description: f.description,
        risk: f.risk,
        rollbackPlan: f.rollbackPlan,
        verificationPlan: f.verificationPlan,
        incidentId: f.incidentId,
        assetIds: form.getAll("assetIds").map(String).filter((id) => z.uuid().safeParse(id).success),
        windowStart: when(f.windowStart),
        windowEnd: when(f.windowEnd),
        ...(byHand ? { manual: true } : { plannedCalls, forAgentId: z.uuid("Choose who carries it out").parse(f.carriedOutBy) }),
      },
      { type: "user", id: user.id },
    );
    redirect(`/changes/${change.id}`);
  });
}

/** The result of a change a person carried out by hand. */
export async function recordResultAction(changeId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.create");
    const outcome = z.enum(["succeeded", "failed"]).parse(form.get("outcome"));
    const notes = z.string().trim().min(1, "Say what happened").max(5000).parse(form.get("notes"));
    await recordManualResult(db(), user.orgId, changeId, outcome, notes, { type: "user", id: user.id });
    return outcome === "succeeded" ? "Recorded: the change succeeded." : "Recorded: the change failed.";
  });
}
