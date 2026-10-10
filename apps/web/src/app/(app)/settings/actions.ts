"use server";

import { generateTotpSecret, getPasswordPolicy, mustEnrolTotp, setSetting, verifyPassword, verifyTotp, writeAudit, type SettingKey } from "@moss/core";
import { roles, userRoles, users } from "@moss/db";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { requirePermission, requireUser, sealTotpSecret } from "@/server/auth";
import { db } from "@/server/db";

const TOGGLES: SettingKey[] = ["agents.kill_switch", "tools.allow_dangerous", "changes.allow_emergency", "changes.require_separate_approver"];

export async function toggleSettingAction(key: SettingKey, value: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    if (!TOGGLES.includes(key)) throw new Error("Unknown setting");
    // The kill switch has its own permission so operators can stop agents without full settings access.
    const user = await requirePermission(key === "agents.kill_switch" ? "killswitch.use" : "settings.manage");
    await setSetting(db(), user.orgId, key, value as never);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: key, details: { value } });
    if (key === "agents.kill_switch") return value ? "Kill switch on: all agents are stopped." : "Kill switch off: agents may run again.";
    return "Setting saved.";
  });
}

export async function setMotionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const motion = z.enum(["system", "on", "off"]).parse(form.get("motion"));
    await db().update(users).set({ motion, updatedAt: new Date() }).where(eq(users.id, user.id));
    return motion === "on" ? "Animations always on." : motion === "off" ? "Animations always off." : "Animations follow your system setting.";
  });
}

/** Hides or brings back the dashboard's Getting started checklist, for this person only. */
export async function setSetupChecklistHiddenAction(hidden: boolean, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    await db()
      .update(users)
      .set({ preferences: { ...user.preferences, hideSetupChecklist: hidden }, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return hidden ? "Getting started dismissed. Bring it back from Settings, Display." : "Getting started is back on the dashboard.";
  });
}

// --- Two-factor enrolment: the pending secret lives in a short-lived httpOnly cookie until confirmed. ---
const PENDING_TOTP = "moss_totp_pending";

export async function startTotpAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    await requireUser({ unblocks: "enrol_totp" });
    (await cookies()).set(PENDING_TOTP, generateTotpSecret(), { httpOnly: true, sameSite: "strict", path: "/settings", maxAge: 600 });
  });
}

export async function confirmTotpAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser({ unblocks: "enrol_totp" });
    const store = await cookies();
    const secret = store.get(PENDING_TOTP)?.value;
    if (!secret) throw new Error("Enrolment expired; start again.");
    const code = z.string().regex(/^\d{6}$/, "Enter the 6-digit code").parse(String(form.get("code") ?? "").replace(/\s/g, ""));
    if (!verifyTotp(secret, code)) throw new Error("That code didn't match. Check your phone's clock and try again.");
    await db().update(users).set({ totpSecretRef: sealTotpSecret(user.id, secret), updatedAt: new Date() }).where(eq(users.id, user.id));
    store.delete({ name: PENDING_TOTP, path: "/settings" });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.totp_enabled", targetType: "user", targetId: user.id });
    return "Two-factor authentication is on.";
  });
}

export async function disableTotpAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser();
    const [row] = await db().select().from(users).where(eq(users.id, user.id));
    if (!row?.passwordHash || !(await verifyPassword(String(form.get("password") ?? ""), row.passwordHash))) throw new Error("Incorrect password.");
    const roleKeys = (await db().select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, user.id))).map((r) => r.key);
    if (mustEnrolTotp(await getPasswordPolicy(db(), user.orgId), { totpEnabled: false, hasPassword: true, roles: roleKeys })) {
      throw new Error("The password policy requires two-factor for you, so it can't be turned off.");
    }
    await db().update(users).set({ totpSecretRef: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.totp_disabled", targetType: "user", targetId: user.id });
    return "Two-factor authentication is off.";
  });
}
