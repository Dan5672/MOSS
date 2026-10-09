"use server";

import { createNote, deleteNote, getNote, updateNote } from "@moss/core";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

const pageSchema = z.object({
  title: z.string().trim().min(1, "Give the page a title").max(120),
  body: z.string().trim().min(1, "Write something").max(20_000),
  parentId: z.uuid().optional(),
  assetId: z.uuid().optional(),
});

/** Creates a page (pageId null) or saves an edit, keeping the previous version in its history. */
export async function savePageAction(pageId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("knowledge.manage");
    const f = pageSchema.parse(formObject(form));
    const actor = { type: "user" as const, id: user.id };
    const input = { title: f.title, body: f.body, parentId: f.parentId ?? null, assetId: f.assetId ?? null };
    const row = pageId ? await updateNote(db(), user.orgId, pageId, input, actor) : await createNote(db(), user.orgId, input, actor);
    redirect(`/wiki/${row.slug}`);
  });
}

export async function deletePageAction(pageId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("knowledge.manage");
    if (!(await getNote(db(), user.orgId, pageId))) throw new Error("Page not found");
    await deleteNote(db(), user.orgId, pageId, { type: "user", id: user.id });
    redirect("/wiki");
  });
}
