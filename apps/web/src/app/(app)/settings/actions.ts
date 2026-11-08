"use server";

import { applyOrgTimeZone, generateTotpSecret, getPasswordPolicy, getSetting, mustEnrolTotp, serverTimeZone, setSetting, verifyTotp, writeAudit, type SettingKey } from "@moss/core";
import { roles, userRoles, users } from "@moss/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { confirmPassword, requirePermission, requireUser, sealTotpSecret, verifyUserTotp, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { rulesWeaken, weakens } from "./hardening";

const TOGGLES: SettingKey[] = [
  "agents.kill_switch",
  "tools.allow_dangerous",
  "changes.allow_emergency",
  "changes.require_separate_approver",
  "tools.allow_vulners",
  "agents.allow_internet",
  "tools.pin_hosts",
  "tools.verify_tls",
  "changes.approval_totp",
  "knowledge.agent_drafts",
  "agents.credentials_need_manager",
  "auth.sso_require_totp",
];

/**
 * Weakening a protection asks for the person's two-factor code. Without two-factor set up, it's refused while
 * approvals need a code (otherwise a stolen session could switch that off first).
 */
async function stepUp(user: CurrentUser, form: FormData | undefined, what: string) {
  if (!user.totpEnabled) {
    if (await getSetting(db(), user.orgId, "changes.approval_totp")) throw new Error("Set up two-factor sign-in first: weakening a protection needs your code.");
    return;
  }
  if (!(await verifyUserTotp(user.id, String(form?.get("code") ?? "")))) {
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update_denied", targetType: "setting", targetId: what, details: { reason: "totp" } });
    throw new Error("That two-factor code didn't match.");
  }
}

/** Which changes chat apps may approve, and the tools emergency changes may use (Settings, Safety). */
export async function saveApprovalRulesAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const level = z.enum(["standard", "low_risk", "off"]).parse(form.get("chatApprovals"));
    const tools = [...new Set(String(form.get("emergencyTools") ?? "").split(/[\s,]+/).filter(Boolean))];
    for (const t of tools) if (!/^[a-z][a-z0-9_]{0,63}$/.test(t)) throw new Error(`"${t}" isn't a tool name`);
    const before = { level: await getSetting(db(), user.orgId, "changes.chat_approvals"), tools: await getSetting(db(), user.orgId, "changes.emergency_tools") };
    if (rulesWeaken(before, { level, tools })) await stepUp(user, form, "changes.chat_approvals");
    await setSetting(db(), user.orgId, "changes.chat_approvals", level);
    await setSetting(db(), user.orgId, "changes.emergency_tools", tools);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "changes.chat_approvals", details: { chatApprovals: level, emergencyTools: tools } });
    return "Approval rules saved.";
  });
}

export async function saveTimeZoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const zone = String(form.get("timeZone") ?? "");
    if (zone && !Intl.supportedValuesOf("timeZone").includes(zone)) throw new Error("Choose a time zone from the list");
    await setSetting(db(), user.orgId, "general.time_zone", zone);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "general.time_zone", details: { value: zone } });
    await applyOrgTimeZone(db(), user.orgId);
    revalidatePath("/", "layout");
    return `Time zone saved: ${zone || `this computer's (${serverTimeZone()})`}. Times on screen use it now; recurring tasks within a minute.`;
  });
}

export async function toggleSettingAction(key: SettingKey, value: boolean, _: ActionState, form?: FormData): Promise<ActionState> {
  return act(async () => {
    if (!TOGGLES.includes(key)) throw new Error("Unknown setting");
    // The kill switch has its own permission so operators can stop agents without full settings access.
    const user = await requirePermission(key === "agents.kill_switch" ? "killswitch.use" : "settings.manage");
    if (weakens(key, value)) await stepUp(user, form, key);
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
    // Two-factor guards sensitive steps (backup downloads), so a stolen session mustn't be able to set its own:
    // an existing one is never replaced here (turning it off needs the password), and setting one up needs the
    // password, or for someone without one (they sign in with Microsoft or Google) a sign-in in the last 10 minutes.
    if (user.totpEnabled) throw new Error("Two-factor is already on. Turn it off first (with your password) to set up a new one.");
    if (user.hasPassword) {
      if (!(await confirmPassword(user, String(form.get("password") ?? ""), "enrol_totp"))) throw new Error("Incorrect password.");
    } else if (Date.now() - user.session.createdAt.getTime() > 10 * 60_000) {
      throw new Error("Sign out and sign in again with Microsoft or Google, then set up two-factor within 10 minutes.");
    }
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
    if (!(await confirmPassword(user, String(form.get("password") ?? ""), "disable_totp"))) throw new Error("Incorrect password.");
    const roleKeys = (await db().select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, user.id))).map((r) => r.key);
    if (mustEnrolTotp(await getPasswordPolicy(db(), user.orgId), { totpEnabled: false, hasPassword: true, roles: roleKeys })) {
      throw new Error("The password policy requires two-factor for you, so it can't be turned off.");
    }
    await db().update(users).set({ totpSecretRef: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.totp_disabled", targetType: "user", targetId: user.id });
    return "Two-factor authentication is off.";
  });
}
