"use server";

import { passwordPolicySchema, PasswordPolicyError, setSetting, setUserPassword, writeAudit } from "@moss/core";
import { hostPins, users } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { act, type ActionState } from "@/server/action";
import { confirmPassword, requirePermission, requireUser } from "@/server/auth";
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
    if (!(await confirmPassword(user, current, "change_password"))) throw new Error("Your current password isn't right.");
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

/**
 * Trusts the key a device now presents (after checking it on the device), or forgets the device so its next key is
 * learned. `shown`: the key the person checked; if the device has presented yet another one since, nothing is trusted.
 */
export async function hostPinAction(id: string, what: "trust" | "forget", shown: string | null, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const where = and(eq(hostPins.id, id), eq(hostPins.orgId, user.orgId));
    const [pin] = await db().select().from(hostPins).where(where);
    if (!pin) throw new Error("That device key is gone.");
    if (what === "trust") {
      if (!pin.changedTo) throw new Error("This device's key hasn't changed.");
      if (pin.changedTo !== shown) throw new Error("The device has presented a different key since this page loaded. Reload and check it again.");
      const trusted = await db().update(hostPins).set({ fingerprint: pin.changedTo, changedTo: null, changedAt: null, updatedAt: new Date() }).where(and(where, eq(hostPins.changedTo, shown))).returning({ id: hostPins.id });
      if (trusted.length === 0) throw new Error("The device has presented a different key since this page loaded. Reload and check it again.");
    } else {
      await db().delete(hostPins).where(where);
    }
    await writeAudit(db(), {
      orgId: user.orgId,
      actorType: "user",
      actorId: user.id,
      action: what === "trust" ? "host_pin.trust" : "host_pin.forget",
      targetType: "host",
      targetId: `${pin.host}:${pin.port}`,
      details: { kind: pin.kind, from: pin.fingerprint, to: what === "trust" ? pin.changedTo : null },
    });
    return what === "trust" ? `Trusted the new key for ${pin.host}.` : `Forgot ${pin.host}'s key. The next one it presents is remembered.`;
  });
}
