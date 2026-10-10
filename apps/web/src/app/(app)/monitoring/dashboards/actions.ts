"use server";

import { createDashboard, DashboardError, deleteDashboard, updateDashboard, type DashboardInput } from "@moss/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";

async function viewer() {
  const user = await requirePermission("monitoring.read");
  return { user, v: { userId: user.id, canManage: user.permissions.has("monitoring.manage") } };
}

export async function createDashboardAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const { user, v } = await viewer();
    const f = formObject(form);
    const d = await createDashboard(db(), user.orgId, v, { name: f.name ?? "", shared: f.shared === "on" });
    redirect(`/monitoring/dashboards/${d.id}?edit=1`);
  });
}

/** Saves the editor's dashboard (name, sharing and widgets). */
export async function saveDashboardAction(id: string, input: DashboardInput): Promise<{ ok?: true; error?: string }> {
  try {
    const { user, v } = await viewer();
    await updateDashboard(db(), user.orgId, v, id, input);
    revalidatePath(`/monitoring/dashboards/${id}`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof DashboardError ? err.message : "The dashboard couldn't be saved." };
  }
}

export async function deleteDashboardAction(id: string): Promise<{ error?: string }> {
  try {
    const { user, v } = await viewer();
    await deleteDashboard(db(), user.orgId, v, id);
  } catch (err) {
    return { error: err instanceof DashboardError ? err.message : "The dashboard couldn't be deleted." };
  }
  redirect("/monitoring/dashboards");
}
