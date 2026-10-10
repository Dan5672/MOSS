"use server";

import { checkNewPassword, getPasswordPolicy, hashPassword, MIN_PASSWORD_LENGTH, writeAudit } from "@moss/core";
import { roles, sessions, userRoles, users } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";

async function roleKeysOf(userId: string) {
  const rows = await db().select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(userRoles.roleId, roles.id)).where(eq(userRoles.userId, userId));
  return rows.map((r) => r.key);
}

/** Only an owner may change another owner, or make someone an owner; nobody changes their own access here. */
async function assertCanManage(actor: CurrentUser, targetId: string, newRole?: string) {
  if (targetId === actor.id) throw new Error("You can't change your own access.");
  const [target] = await db().select().from(users).where(and(eq(users.id, targetId), eq(users.orgId, actor.orgId)));
  if (!target) throw new Error("User not found");
  const actorIsOwner = (await roleKeysOf(actor.id)).includes("owner");
  if (!actorIsOwner && ((await roleKeysOf(targetId)).includes("owner") || newRole === "owner")) {
    throw new Error("Only an owner can change an owner's access or create owners.");
  }
  return target;
}

async function roleId(orgId: string, key: string) {
  const [role] = await db().select().from(roles).where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  if (!role || key === "agent") throw new Error("Unknown role");
  return role.id;
}

export async function addUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const actor = await requirePermission("users.manage");
    const input = z
      .object({
        displayName: z.string().min(1).max(100),
        email: z.email(),
        role: z.string(),
        password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200),
      })
      .parse(formObject(form));
    if (input.role === "owner" && !(await roleKeysOf(actor.id)).includes("owner")) throw new Error("Only an owner can create owners.");
    await checkNewPassword(db(), await getPasswordPolicy(db(), actor.orgId), input.password);
    const rid = await roleId(actor.orgId, input.role);
    const [user] = await db()
      .insert(users)
      .values({ orgId: actor.orgId, email: input.email.toLowerCase(), displayName: input.displayName, passwordHash: await hashPassword(input.password) })
      .onConflictDoNothing()
      .returning();
    if (!user) throw new Error("Someone with that email already exists.");
    await db().insert(userRoles).values({ userId: user.id, roleId: rid });
    await writeAudit(db(), { orgId: actor.orgId, actorType: "user", actorId: actor.id, action: "user.add", targetType: "user", targetId: user.id, details: { email: user.email, role: input.role } });
    return `Added ${input.displayName}. Share their password with them securely; they can turn on two-factor in Settings.`;
  });
}

export async function setRoleAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const actor = await requirePermission("users.manage");
    const role = z.string().parse(form.get("role"));
    await assertCanManage(actor, userId, role);
    const rid = await roleId(actor.orgId, role);
    await db().transaction(async (tx) => {
      await tx.delete(userRoles).where(eq(userRoles.userId, userId));
      await tx.insert(userRoles).values({ userId, roleId: rid });
    });
    await writeAudit(db(), { orgId: actor.orgId, actorType: "user", actorId: actor.id, action: "user.set_role", targetType: "user", targetId: userId, details: { role } });
    return "Role updated.";
  });
}

export async function setUserStatusAction(userId: string, status: "active" | "disabled", _: ActionState): Promise<ActionState> {
  return act(async () => {
    const actor = await requirePermission("users.manage");
    await assertCanManage(actor, userId);
    await db().update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
    // Disabling signs them out everywhere.
    if (status === "disabled") await db().delete(sessions).where(eq(sessions.userId, userId));
    await writeAudit(db(), { orgId: actor.orgId, actorType: "user", actorId: actor.id, action: status === "disabled" ? "user.disable" : "user.enable", targetType: "user", targetId: userId });
    return status === "disabled" ? "Access revoked." : "Access restored.";
  });
}
