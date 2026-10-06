"use server";

import { createNote, deleteNote, updateNote } from "@moss/core";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

function noteFromForm(form: FormData) {
  const f = formObject(form);
  return {
    title: z.string().trim().min(1, "Give the note a title").parse(f.title ?? ""),
    body: z.string().trim().min(1, "Write the note").parse(f.body ?? ""),
    subject: f.subject ?? null,
    tags: (f.tags ?? "").split(/[,\s]+/).filter(Boolean),
  };
}

export async function addNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("knowledge.manage");
    const n = await createNote(db(), user.orgId, noteFromForm(form), { type: "user", id: user.id });
    return `Saved "${n.title}".`;
  });
}

export async function updateNoteAction(noteId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("knowledge.manage");
    await updateNote(db(), user.orgId, noteId, noteFromForm(form), { type: "user", id: user.id });
    return "Note updated.";
  });
}

export async function deleteNoteAction(noteId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("knowledge.manage");
    await deleteNote(db(), user.orgId, noteId, { type: "user", id: user.id });
    return "Note deleted.";
  });
}
