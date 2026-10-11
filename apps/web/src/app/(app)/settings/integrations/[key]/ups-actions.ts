"use server";

import { approveUpsPlan, getUpsPlan, saveUpsPlan, upsStepSchema, writeAudit, type UpsPlan, type UpsStep } from "@moss/core";
import { agents, agentToolOverrides, secretGrants, secrets } from "@moss/db";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { PermissionError, requirePermission, verifyUserTotp, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";

const PAGE = "/settings/integrations/nut";

/** The plan's agent gets the tools and secrets its steps use (the gate still checks each secret's scope). */
async function grantPlanAccess(user: CurrentUser, plan: UpsPlan) {
  if (!plan.agentId || !plan.steps.length) return;
  const tools = [...new Set(plan.steps.map((s) => (s.type === "proxmox" ? "proxmox_guest_power" : "host_shutdown")))];
  for (const tool of tools) {
    await db().insert(agentToolOverrides).values({ agentId: plan.agentId, tool, granted: true }).onConflictDoUpdate({ target: [agentToolOverrides.agentId, agentToolOverrides.tool], set: { granted: true } });
  }
  const names = [...new Set(plan.steps.map((s) => (s.type === "proxmox" ? "proxmox-token" : s.secret)))];
  const rows = await db().select({ id: secrets.id, name: secrets.name }).from(secrets).where(and(eq(secrets.orgId, user.orgId), inArray(secrets.name, names)));
  const missing = names.filter((n) => !rows.some((r) => r.name === n));
  if (missing.length) throw new Error(`There's no stored secret called ${missing.join(", ")}.`);
  for (const r of rows) await db().insert(secretGrants).values({ secretId: r.id, agentId: plan.agentId, grantedBy: user.id }).onConflictDoNothing();
}

/** Changing the plan hands an agent shutdown tools and secrets, so it takes managing integrations and secrets. */
async function planManager() {
  const user = await requirePermission("integrations.manage");
  if (!user.permissions.has("secrets.manage")) throw new PermissionError("secrets.manage");
  return user;
}

async function store(user: CurrentUser, plan: UpsPlan) {
  const saved = await saveUpsPlan(db(), user.orgId, plan);
  await grantPlanAccess(user, saved);
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "ups.shutdown_plan", details: { ...saved } });
  revalidatePath(PAGE);
  return saved;
}

export async function saveUpsPlanSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await planManager();
    const f = formObject(form);
    const plan = await getUpsPlan(db(), user.orgId);
    const agentId = f.agentId ? z.uuid().parse(f.agentId) : undefined;
    if (agentId) {
      const [a] = await db().select({ status: agents.status }).from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, user.orgId)));
      if (!a || a.status === "fired") throw new Error("Agent not found.");
    }
    const mode = z.enum(["off", "ask", "auto"]).parse(f.mode ?? "off");
    if (mode !== "off" && !agentId) throw new Error("Choose the agent that carries the plan out.");
    const saved = await store(user, { ...plan, mode, agentId, runtimeMinutes: z.coerce.number().int().min(1).max(120).parse(f.runtimeMinutes ?? 10) });
    return mode === "auto" && !saved.approval ? "Saved. Approve the plan below so it can run without asking." : "Saved.";
  });
}

export async function addUpsStepAction(type: "proxmox" | "ssh", _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await planManager();
    const f = formObject(form);
    const step: UpsStep = upsStepSchema.parse(
      type === "proxmox"
        ? { type, label: f.label, node: f.node, kind: f.kind, vmid: Number(f.vmid) }
        : { type, label: f.label, target: f.target, user: f.user, port: Number(f.port ?? 22), secret: f.secret },
    );
    const plan = await getUpsPlan(db(), user.orgId);
    if (plan.steps.length >= 20) throw new Error("At most 20 steps.");
    await store(user, { ...plan, steps: [...plan.steps, step] });
    return `Added ${step.label}.`;
  });
}

export async function moveUpsStepAction(index: number, by: -1 | 1, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await planManager();
    const plan = await getUpsPlan(db(), user.orgId);
    const to = index + by;
    if (to < 0 || to >= plan.steps.length) return;
    const steps = [...plan.steps];
    [steps[index], steps[to]] = [steps[to]!, steps[index]!];
    await store(user, { ...plan, steps });
  });
}

export async function removeUpsStepAction(index: number, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await planManager();
    const plan = await getUpsPlan(db(), user.orgId);
    await store(user, { ...plan, steps: plan.steps.filter((_, i) => i !== index) });
    return "Removed.";
  });
}

/** Approves the plan in advance, with a fresh two-factor code: from then on it runs without asking. */
export async function approveUpsPlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("changes.approve");
    if (!user.totpEnabled) throw new Error("Approving in advance needs two-factor sign-in. Turn it on in Settings → General first.");
    if (!(await verifyUserTotp(user.id, String(form.get("code") ?? "")))) throw new Error("That code didn't match.");
    await approveUpsPlan(db(), user.orgId, user.id);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "ups.plan_approved", targetType: "setting", targetId: "ups.shutdown_plan", details: {} });
    revalidatePath(PAGE);
    return "Approved. In a power cut, MOSS will run the plan without asking.";
  });
}
