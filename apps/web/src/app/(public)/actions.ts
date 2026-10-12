"use server";

import { syncBuiltInSkills } from "@moss/agent";
import { bootstrapOrg, MIN_PASSWORD_LENGTH, writeAudit } from "@moss/core";
import { users } from "@moss/db";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/server/action";
import { formObject } from "@/server/action";
import { endSession, isSetUp, login, startSession, verifyUserTotp } from "@/server/auth";
import { config } from "@/server/config";
import { createThrottle } from "@/server/throttle";
import { openSsoCookie, safeNext, SSO_2FA_COOKIE, type SsoSecondFactor } from "@/server/sso";
import { db } from "@/server/db";
import { library } from "@/server/services";

const setupSchema = z
  .object({
    orgName: z.string().min(1, "Give your network a name").max(100),
    ownerName: z.string().min(1, "Enter your name").max(100),
    ownerEmail: z.email("Enter a valid email"),
    ownerPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`).max(200),
    confirmPassword: z.string(),
    accept: z.literal("on", { error: "Confirm that you may scan and manage this network" }),
  })
  .refine((v) => v.ownerPassword === v.confirmPassword, { message: "Passwords don't match", path: ["confirmPassword"] });

// Guesses at the setup code, per address (8 hex digits wouldn't last long unthrottled; one key for everyone would let
// anyone on the network keep the owner from setting up).
// shortcut: keyed by X-Forwarded-For, which Caddy sets; a direct visitor could vary it. Fine for a one-time step.
const setupAttempts = createThrottle(10);

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function setupAction(_: ActionState, form: FormData): Promise<ActionState> {
  if (await isSetUp()) redirect("/login");
  // Whoever reaches a fresh install first would own it; the code from init.sh proves they set it up.
  const code = config.setupCode();
  if (code && !setupAttempts.take((await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "?")) return { error: "Too many wrong setup codes. Try again in a few minutes." };
  if (code && !sameText(String(form.get("setupCode") ?? "").trim(), code)) return { error: "That setup code is wrong. It's in deploy/secrets/setup.code." };
  const parsed = setupSchema.safeParse(formObject(form));
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("\n") };
  const { org, owner } = await bootstrapOrg(db(), parsed.data);
  await syncBuiltInSkills(db(), org.id, (await library()).skills.values());
  await startSession(owner.id);
  redirect("/");
}

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { email, password, code } = formObject(form);
  if (!email || !password) return { error: "Enter your email and password." };
  const res = await login(email, password, code);
  if (!res.ok) return { error: res.error, needTotp: res.needTotp };
  redirect("/");
}

/** The MOSS two-factor code after signing in with Microsoft or Google. */
export async function ssoSecondFactorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const jar = await cookies();
  const pending = openSsoCookie<SsoSecondFactor>(jar.get(SSO_2FA_COOKIE)?.value);
  if (!pending) return { error: "That sign-in has expired. Sign in again." };
  const code = String(form.get("code") ?? "").trim();
  if (!code) return { error: "Enter the code from your authenticator app." };
  const [user] = await db().select({ orgId: users.orgId }).from(users).where(eq(users.id, pending.userId));
  if (!user) return { error: "That sign-in has expired. Sign in again." };
  const ok = await verifyUserTotp(pending.userId, code).catch((err: Error) => err.message);
  if (typeof ok === "string") return { error: ok };
  if (!ok) {
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: pending.userId, action: "auth.login_failed", details: { method: pending.provider, reason: "totp" } });
    return { error: "That code isn't right." };
  }
  jar.delete({ name: SSO_2FA_COOKIE, path: "/login" });
  await startSession(pending.userId, pending.provider);
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: pending.userId, action: "auth.login", details: { method: pending.provider } });
  redirect(safeNext(pending.next));
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}
