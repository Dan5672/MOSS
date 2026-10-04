// Agent lifecycle: hire (from a template), pause, resume, fire and upskill. Every action is audited.
import { writeAudit } from "@moss/core";
import { agents, agentSchedules, agentSkills, roles, secretGrants, skills, type Database } from "@moss/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { AgentTemplate } from "./library.js";

export interface Actor {
  orgId: string;
  userId: string;
}

async function audit(db: Database, actor: Actor, action: string, agentId: string, details: Record<string, unknown> = {}) {
  await writeAudit(db, { orgId: actor.orgId, actorType: "user", actorId: actor.userId, action, targetType: "agent", targetId: agentId, details });
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
  const [agentRole] = await db.select().from(roles).where(and(eq(roles.orgId, actor.orgId), eq(roles.key, "agent")));
  // Report to an active agent hired from the manager template, if there is one.
  const [manager] = template.reportsTo
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, actor.orgId), eq(agents.templateKey, template.reportsTo), ne(agents.status, "fired")))
        .limit(1)
    : [];

  const skillRows = template.skills.length
    ? await db.select().from(skills).where(and(eq(skills.orgId, actor.orgId), inArray(skills.key, template.skills)))
    : [];
  const missing = template.skills.filter((k) => !skillRows.some((s) => s.key === k));
  if (missing.length) throw new Error(`Skills not installed: ${missing.join(", ")}`);

  const agent = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        orgId: actor.orgId,
        name: input.name ?? template.defaultName,
        title: template.title,
        templateKey: template.key,
        modelId: input.modelId,
        systemPrompt: template.systemPrompt,
        effort: template.effort,
        maxStepsPerRun: template.maxStepsPerRun,
        roleId: agentRole?.id,
        reportsToAgentId: manager?.id ?? null,
        reportsToUserId: manager ? null : actor.userId,
      })
      .returning();
    if (skillRows.length) {
      await tx.insert(agentSkills).values(skillRows.map((s) => ({ agentId: row!.id, skillId: s.id, grantedBy: actor.userId })));
    }
    if (template.schedules.length) {
      await tx.insert(agentSchedules).values(template.schedules.map((s) => ({ orgId: actor.orgId, agentId: row!.id, cron: s.cron, task: s.task })));
    }
    return row!;
  });
  await audit(db, actor, "agent.hire", agent.id, { template: template.key, name: agent.name, skills: template.skills });
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
  await loadOwnAgent(db, actor, agentId);
  await db.transaction(async (tx) => {
    await tx.update(agents).set({ status: "fired", firedAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agentId));
    await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    await tx.delete(secretGrants).where(eq(secretGrants.agentId, agentId));
    await tx.update(agentSchedules).set({ enabled: false }).where(eq(agentSchedules.agentId, agentId));
  });
  await audit(db, actor, "agent.fire", agentId);
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
  await db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skill.id)));
  await audit(db, actor, "agent.remove_skill", agentId, { skill: skillKey });
}
