"use server";

import { passwordPolicySchema, PasswordPolicyError, setSetting, setUserPassword, verifyPassword, writeAudit } from "@moss/core";
import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { requirePermission, requireUser } from "@/server/auth";
import { db } from "@/server/db";

const on = (v: FormDataEntryValue | null) => v === "on" || v === "true";

/** Changes your own password, under the policy. */
export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requireUser({ unblocks: "change_password" });
    const current = String(form.get("current") ?? "");
    const next = String(form.get("password") ?? "");
    if (next !== String(form.get("confirm") ?? "")) throw new Error("The new passwords don't match.");
    const [row] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!row?.hash) throw new Error("You sign in through your organisation's single sign-on, so there's no MOSS password to change.");
    if (!(await verifyPassword(current, row.hash))) throw new Error("Your current password isn't right.");
    try {
      await setUserPassword(db(), user.orgId, user.id, next);
    } catch (err) {
      if (err instanceof PasswordPolicyError) throw new Error(err.message);
      throw err;
    }
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "user.password_change", targetType: "user", targetId: user.id, details: {} });
    return "Password changed.";
  });
}

/** Saves the password policy. Turning on required two-factor needs it on for you first, so you can't lock yourself out. */
export async function savePasswordPolicyAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const num = (k: string) => z.coerce.number().int().parse(form.get(k) ?? 0);
    const policy = passwordPolicySchema.parse({
      minLength: num("minLength"),
      requireLower: on(form.get("requireLower")),
      requireUpper: on(form.get("requireUpper")),
      requireDigit: on(form.get("requireDigit")),
      requireSymbol: on(form.get("requireSymbol")),
      history: num("history"),
      maxAgeDays: num("maxAgeDays"),
      requireTotp: String(form.get("requireTotp") ?? "none"),
      checkBreached: on(form.get("checkBreached")),
    });
    if (policy.requireTotp !== "none" && !user.totpEnabled) {
      throw new Error("Turn on two-factor for yourself first (Settings → General), so requiring it can't lock you out.");
    }
    await setSetting(db(), user.orgId, "auth.password_policy", policy);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "auth.password_policy", details: policy });
    return "Password policy saved. New and changed passwords must follow it.";
  });
}
