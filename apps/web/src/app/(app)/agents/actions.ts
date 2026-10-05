"use server";

import { fireAgent, hireCustom, hireFromTemplate, pauseAgent, removeSkill, resumeAgent, upskillAgent } from "@moss/agent";
import { writeAudit } from "@moss/core";
import { agents, budgets, models } from "@moss/db";
import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission } from "@/server/auth";
import { db } from "@/server/db";
import { library, queueRun } from "@/server/services";

async function ownAgent(orgId: string, agentId: string) {
  const [agent] = await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new Error("Agent not found");
  return agent;
}

export async function hireAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const input = z
      .object({ templateKey: z.string(), modelId: z.uuid("Choose a model"), name: z.string().max(60).optional() })
      .parse(formObject(form));
    const template = (await library()).templates.get(input.templateKey);
    if (!template) throw new Error("Unknown template");
    const [model] = await db().select().from(models).where(and(eq(models.id, input.modelId), eq(models.orgId, user.orgId)));
    if (!model) throw new Error("Unknown model");
    const agent = await hireFromTemplate(db(), { orgId: user.orgId, userId: user.id }, { template, modelId: model.id, name: input.name });
    redirect(`/agents/${agent.id}`);
  });
}

const customHireSchema = z.object({
  name: z.string().min(1, "Give the agent a name").max(60),
  title: z.string().min(1, "Give the agent a job title").max(60),
  systemPrompt: z.string().min(20, "Describe the agent's job in a sentence or two").max(8000),
  modelId: z.uuid("Choose a model"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  skills: z.array(z.string()).max(50),
});

export async function hireCustomAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const input = customHireSchema.parse({ ...formObject(form), skills: form.getAll("skills").map(String) });
    const [model] = await db().select().from(models).where(and(eq(models.id, input.modelId), eq(models.orgId, user.orgId)));
    if (!model) throw new Error("Unknown model");
    const agent = await hireCustom(db(), { orgId: user.orgId, userId: user.id }, input);
    redirect(`/agents/${agent.id}`);
  });
}

export async function runNowAction(agentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const agent = await ownAgent(user.orgId, agentId);
    const task = z.string().min(3, "Describe the task").max(4000).parse(form.get("task"));
    if (agent.status !== "active") throw new Error(`${agent.name} is ${agent.status}`);
    const job = await queueRun({ agentId, task, trigger: "manual" });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "agent.run_requested", targetType: "agent", targetId: agentId, details: { task } });
    return job ? `${agent.name} will start shortly.` : `${agent.name} already has a run waiting; this one was not queued.`;
  });
}

export async function setStatusAction(agentId: string, status: "paused" | "active" | "fired", _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const actor = { orgId: user.orgId, userId: user.id };
    await ownAgent(user.orgId, agentId);
    if (status === "paused") await pauseAgent(db(), actor, agentId);
    if (status === "active") await resumeAgent(db(), actor, agentId);
    if (status === "fired") await fireAgent(db(), actor, agentId);
    return status === "fired" ? "Agent fired." : status === "paused" ? "Agent paused." : "Agent resumed.";
  });
}

export async function addSkillAction(agentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    const key = z.string().min(1, "Choose a skill").parse(form.get("skill"));
    await upskillAgent(db(), { orgId: user.orgId, userId: user.id }, agentId, key);
    return "Skill added.";
  });
}

export async function removeSkillAction(agentId: string, key: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    await removeSkill(db(), { orgId: user.orgId, userId: user.id }, agentId, key);
    return "Skill removed.";
  });
}

const budgetSchema = z.object({
  period: z.enum(["day", "month"]),
  unit: z.enum(["tokens", "usd"]),
  hardLimit: z.coerce.number().positive("Hard limit must be positive"),
  softLimit: z.coerce.number().positive().optional(),
});

/** agentId null = organisation-wide budget. */
export async function setBudgetAction(agentId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.budget");
    if (agentId) await ownAgent(user.orgId, agentId);
    const b = budgetSchema.parse(formObject(form));
    if (b.softLimit && b.softLimit >= b.hardLimit) throw new Error("The soft limit must be below the hard limit");
    const scope = and(eq(budgets.orgId, user.orgId), agentId ? eq(budgets.agentId, agentId) : isNull(budgets.agentId), eq(budgets.period, b.period), eq(budgets.unit, b.unit));
    await db().delete(budgets).where(scope);
    await db()
      .insert(budgets)
      .values({ orgId: user.orgId, agentId, period: b.period, unit: b.unit, hardLimit: String(b.hardLimit), softLimit: b.softLimit ? String(b.softLimit) : null });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "budget.set", targetType: agentId ? "agent" : "org", targetId: agentId, details: b });
    return "Budget saved.";
  });
}

export async function deleteBudgetAction(budgetId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.budget");
    await db().delete(budgets).where(and(eq(budgets.id, budgetId), eq(budgets.orgId, user.orgId)));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "budget.delete", targetType: "budget", targetId: budgetId });
    return "Budget removed.";
  });
}

export async function setModelAction(agentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("agents.manage");
    await ownAgent(user.orgId, agentId);
    const modelId = z.uuid("Choose a model").parse(form.get("modelId"));
    const effort = z.enum(["low", "medium", "high", "xhigh", "max"]).parse(form.get("effort"));
    const [model] = await db().select().from(models).where(and(eq(models.id, modelId), eq(models.orgId, user.orgId)));
    if (!model) throw new Error("Unknown model");
    await db().update(agents).set({ modelId, effort, updatedAt: new Date() }).where(eq(agents.id, agentId));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "agent.set_model", targetType: "agent", targetId: agentId, details: { modelId, effort } });
    return "Model updated.";
  });
}
