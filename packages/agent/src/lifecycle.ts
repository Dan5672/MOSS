// Agent lifecycle: hire (from a template or custom), pause, resume, fire and upskill. Every action is audited.
import { writeAudit } from "@moss/core";
import { agents, agentSchedules, agentSkills, models, roles, secretGrants, skills, type Database } from "@moss/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AgentTemplate } from "./library.js";

export interface Actor {
  orgId: string;
  /** null when MOSS itself acts (e.g. hiring Moss on a new install). */
  userId: string | null;
}

/** The template of the MOSS expert every install has. It can be paused, but not fired. */
export const MOSS_TEMPLATE = "moss";

async function audit(db: Database, actor: Actor, action: string, agentId: string, details: Record<string, unknown> = {}) {
  await writeAudit(db, { orgId: actor.orgId, actorType: actor.userId ? "user" : "system", actorId: actor.userId, action, targetType: "agent", targetId: agentId, details });
}

async function loadOwnAgent(db: Database, actor: Actor, agentId: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, actor.orgId)));
  if (!agent) throw new Error("Agent not found");
  return agent;
}

export interface HireInput {
  template: AgentTemplate;
  modelId: string;
  name?: string;
}

export async function hireFromTemplate(db: Database, actor: Actor, input: HireInput) {
  const { template } = input;
  return hire(db, actor, { ...template, templateKey: template.key, name: input.name ?? template.defaultName, modelId: input.modelId });
}

export interface CustomHireInput {
  name: string;
  title: string;
  /** What the agent is for and how it should work; becomes its system prompt. */
  systemPrompt: string;
  skills: string[];
  modelId: string;
  effort?: AgentTemplate["effort"];
  maxStepsPerRun?: number;
}

/** Hires an agent the user designed themselves rather than from a library template. */
export async function hireCustom(db: Database, actor: Actor, input: CustomHireInput) {
  return hire(db, actor, {
    ...input,
    templateKey: null,
    effort: input.effort ?? "medium",
    maxStepsPerRun: input.maxStepsPerRun ?? 25,
    reportsTo: null,
    schedules: [],
  });
}

interface HireSpec extends Pick<AgentTemplate, "title" | "systemPrompt" | "effort" | "maxStepsPerRun" | "skills" | "reportsTo" | "schedules"> {
  templateKey: string | null;
  name: string;
  modelId: string;
}

async function hire(db: Database, actor: Actor, spec: HireSpec) {
  const [agentRole] = await db.select().from(roles).where(and(eq(roles.orgId, actor.orgId), eq(roles.key, "agent")));
  // Report to an active agent hired from the manager template, if there is one.
  const [manager] = spec.reportsTo
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, actor.orgId), eq(agents.templateKey, spec.reportsTo), ne(agents.status, "fired")))
        .limit(1)
    : [];

  const chosen = spec.skills.length
    ? await db.select().from(skills).where(and(eq(skills.orgId, actor.orgId), inArray(skills.key, spec.skills)))
    : [];
  const missing = spec.skills.filter((k) => !chosen.some((s) => s.key === k));
  if (missing.length) throw new Error(`Skills not installed: ${missing.join(", ")}`);
  // Every agent knows how MOSS works (except Moss itself, which only explains it).
  const core = spec.templateKey === MOSS_TEMPLATE ? [] : await db.select().from(skills).where(and(eq(skills.orgId, actor.orgId), eq(skills.core, true)));
  const skillRows = [...chosen, ...core.filter((c) => !chosen.some((s) => s.id === c.id))];

  const agent = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        orgId: actor.orgId,
        name: spec.name,
        title: spec.title,
        templateKey: spec.templateKey,
        modelId: spec.modelId,
        systemPrompt: spec.systemPrompt,
        effort: spec.effort,
        maxStepsPerRun: spec.maxStepsPerRun,
        roleId: agentRole?.id,
        reportsToAgentId: manager?.id ?? null,
        reportsToUserId: manager ? null : actor.userId,
      })
      .returning();
    if (skillRows.length) {
      await tx.insert(agentSkills).values(skillRows.map((s) => ({ agentId: row!.id, skillId: s.id, grantedBy: actor.userId })));
    }
    if (spec.schedules.length) {
      await tx.insert(agentSchedules).values(spec.schedules.map((s) => ({ orgId: actor.orgId, agentId: row!.id, cron: s.cron, task: s.task })));
    }
    return row!;
  });
  await audit(db, actor, "agent.hire", agent.id, { template: spec.templateKey, name: agent.name, skills: spec.skills });
  return agent;
}

export async function pauseAgent(db: Database, actor: Actor, agentId: string, reason = "Paused by user") {
  const agent = await loadOwnAgent(db, actor, agentId);
  if (agent.status === "fired") throw new Error("Agent has been fired");
  await db.update(agents).set({ status: "paused", pausedReason: reason, updatedAt: new Date() }).where(eq(agents.id, agentId));
  await audit(db, actor, "agent.pause", agentId, { reason });
}

export async function resumeAgent(db: Database, actor: Actor, agentId: string) {
  const agent = await loadOwnAgent(db, actor, agentId);
  if (agent.status === "fired") throw new Error("Agent has been fired");
  await db.update(agents).set({ status: "active", pausedReason: null, updatedAt: new Date() }).where(eq(agents.id, agentId));
  await audit(db, actor, "agent.resume", agentId);
}

/** Firing is permanent: the agent is archived and loses every skill, secret grant and schedule. */
export async function fireAgent(db: Database, actor: Actor, agentId: string) {
  const agent = await loadOwnAgent(db, actor, agentId);
  if (agent.templateKey === MOSS_TEMPLATE) throw new Error(`${agent.name} looks after MOSS itself and can't be fired. Pause it instead.`);
  await db.transaction(async (tx) => {
    await tx.update(agents).set({ status: "fired", firedAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
    await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    await tx.delete(secretGrants).where(eq(secretGrants.agentId, agentId));
    await tx.update(agentSchedules).set({ enabled: false }).where(eq(agentSchedules.agentId, agentId));
  });
  await audit(db, actor, "agent.fire", agentId);
}

/**
 * Every install has a Moss: the expert on MOSS itself. Hired automatically once the org has a model to
 * run it on, and again if it's ever missing. Returns the new agent's id, or null if nothing was needed.
 */
export async function ensureMoss(db: Database, orgId: string, template: AgentTemplate | undefined): Promise<string | null> {
  if (!template) return null;
  const [existing] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.templateKey, MOSS_TEMPLATE), ne(agents.status, "fired")));
  if (existing) return null;
  // The model the newest active agent uses (most likely the one the owner prefers), else any enabled model.
  const [recent] = await db
    .select({ id: models.id })
    .from(agents)
    .innerJoin(models, and(eq(models.id, agents.modelId), eq(models.enabled, true)))
    .where(and(eq(agents.orgId, orgId), eq(agents.status, "active")))
    .orderBy(desc(agents.hiredAt))
    .limit(1);
  const [any] = recent ? [] : await db.select({ id: models.id }).from(models).where(and(eq(models.orgId, orgId), eq(models.enabled, true))).limit(1);
  const model = recent ?? any;
  if (!model) return null;
  const agent = await hireFromTemplate(db, { orgId, userId: null }, { template, modelId: model.id });
  return agent.id;
}

export async function upskillAgent(db: Database, actor: Actor, agentId: string, skillKey: string) {
  const agent = await loadOwnAgent(db, actor, agentId);
  if (agent.status === "fired") throw new Error("Agent has been fired");
  const [skill] = await db.select().from(skills).where(and(eq(skills.orgId, actor.orgId), eq(skills.key, skillKey)));
  if (!skill) throw new Error(`Unknown skill ${skillKey}`);
  await db.insert(agentSkills).values({ agentId, skillId: skill.id, grantedBy: actor.userId }).onConflictDoNothing();
  await audit(db, actor, "agent.upskill", agentId, { skill: skillKey, toolGrants: skill.toolGrants });
}

export async function removeSkill(db: Database, actor: Actor, agentId: string, skillKey: string) {
  await loadOwnAgent(db, actor, agentId);
  const [skill] = await db.select().from(skills).where(and(eq(skills.orgId, actor.orgId), eq(skills.key, skillKey)));
  if (!skill) throw new Error(`Unknown skill ${skillKey}`);
  if (skill.core) throw new Error(`${skill.name} is how MOSS itself works: every agent has it`);
  await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skill.id)));
  await audit(db, actor, "agent.remove_skill", agentId, { skill: skillKey });
}
