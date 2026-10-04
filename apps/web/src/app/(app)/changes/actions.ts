"use server";

import { addChangeComment, approveChange, cancelChange, rejectChange } from "@moss/core";
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
