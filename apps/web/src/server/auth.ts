import "server-only";
import {
  decryptSecret,
  encryptSecret,
  anySsoAvailable,
  ssoAvailable,
  getPasswordPolicy,
  getSetting,
  mustEnrolTotp,
  passwordExpired,
  generateToken,
  hashToken,
  userPermissions,
  verifyPassword,
  totpStep,
  writeAudit,
  type Permission,
} from "@moss/core";
import { orgs, roles, sessions, userRoles, users, type UserPreferences } from "@moss/db";
import { and, eq, gt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { config } from "./config";
import { db } from "./db";
import { createThrottle } from "./throttle";

export const SESSION_COOKIE = "moss_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class PermissionError extends Error {
  constructor(permission: Permission) {
    super(`You don't have permission to do this (${permission}).`);
  }
}

export interface CurrentUser {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  totpEnabled: boolean;
  motion: "system" | "on" | "off";
  preferences: UserPreferences;
  permissions: Set<Permission>;
  /**
   * Something the password policy needs done before anything else: set up two-factor, or change an
   * expired password. Every page but the one that does it redirects there.
   */
  blocker: "enrol_totp" | "change_password" | null;
  /** How and when this session signed in (sensitive steps can ask for a recent sign-in). */
  session: { method: "password" | "microsoft" | "google"; createdAt: Date };
  hasPassword: boolean;
}

/** The pages a blocked person may still use (the one that fixes it). */
const BLOCKER_PAGE = { enrol_totp: "/settings", change_password: "/settings/security" } as const;

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db()
    .select({ user: users, authMethod: sessions.authMethod, sessionCreatedAt: sessions.createdAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.status !== "active") return null;
  // A Microsoft or Google session ends once signing in that way stops (switched off, licence lapsed).
  if (row.authMethod !== "password" && !(await ssoAvailable(db(), row.user.orgId, row.authMethod))) return null;
  const [policy, roleRows] = await Promise.all([
    getPasswordPolicy(db(), row.user.orgId),
    db().select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, row.user.id)),
  ]);
  const hasPassword = !!row.user.passwordHash;
  // Signed in with Microsoft or Google: the provider checked MFA, and there's no MOSS password to expire.
  const blocker = row.authMethod !== "password" ? null : mustEnrolTotp(policy, { totpEnabled: !!row.user.totpSecretRef, hasPassword, roles: roleRows.map((r) => r.key) })
    ? "enrol_totp"
    : hasPassword && passwordExpired(policy, row.user.passwordChangedAt)
      ? "change_password"
      : null;
  return {
    blocker,
    session: { method: row.authMethod, createdAt: row.sessionCreatedAt },
    hasPassword,
    id: row.user.id,
    orgId: row.user.orgId,
    email: row.user.email,
    displayName: row.user.displayName,
    totpEnabled: !!row.user.totpSecretRef,
    motion: row.user.motion,
    preferences: row.user.preferences,
    permissions: await userPermissions(db(), row.user.id),
  };
});

/**
 * The signed-in user, or a redirect to sign in. Someone the password policy has blocked (two-factor to set
 * up, a password to change) is sent to the page that fixes it, unless this page or action is that fix:
 * those pass `unblocks` (and the app layout passes "any", since every page checks for itself).
 */
export async function requireUser(opts: { unblocks?: CurrentUser["blocker"] | "any" } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.blocker && opts.unblocks !== "any" && opts.unblocks !== user.blocker) {
    redirect(`${BLOCKER_PAGE[user.blocker]}?required=${user.blocker}`);
  }
  return user;
}

/** For server actions: authenticate and authorize in one step. Never rely on the proxy alone. */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.permissions.has(permission)) throw new PermissionError(permission);
  return user;
}

export async function isSetUp(): Promise<boolean> {
  return (await db().select({ id: orgs.id }).from(orgs).limit(1)).length > 0;
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export async function startSession(userId: string, method: "password" | "microsoft" | "google" = "password") {
  const token = generateToken("mss");
  const h = await headers();
  await db()
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: await clientIp(),
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
      authMethod: method,
    });
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure whenever the sign-in came over HTTPS (the https service says so), so nothing needs setting by hand.
    secure: config.secureCookies() || h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function endSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  store.delete(SESSION_COOKIE);
}

// --- Login throttling: per email+IP for signing in, per person for re-checks. ---
const attempts = createThrottle();
const TOO_MANY = "Too many attempts. Try again in a few minutes.";

function throttleKey(email: string, ip: string | null) {
  return `${email.toLowerCase()}|${ip ?? "?"}`;
}

export type LoginResult = { ok: true } | { ok: false; error: string; needTotp?: boolean };

export async function login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
  const ip = await clientIp();
  const key = throttleKey(email, ip);
  if (!attempts.take(key)) return { ok: false, error: TOO_MANY };
  const fail = async (orgId: string | null, userId: string | null, reason: string): Promise<LoginResult> => {
    if (orgId) await writeAudit(db(), { orgId, actorType: "user", actorId: userId, action: "auth.login_failed", details: { email, ip, reason } });
    return { ok: false, error: "Incorrect email, password or code." };
  };

  const [user] = await db().select().from(users).where(eq(users.email, email.toLowerCase()));
  // Verify a password even when the user doesn't exist, so timing doesn't reveal which emails exist.
  const valid = await verifyPassword(password, user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!user || !valid || user.status !== "active") return fail(user?.orgId ?? null, user?.id ?? null, "password");

  // Single sign-on only: owners keep their password (and two-factor) in case sign-in breaks.
  // Only while signing in with Microsoft or Google works: a lapsed licence or a switched-off integration can't lock people out.
  if ((await getSetting(db(), user.orgId, "auth.sso_only")) && !(await isOwner(user.id)) && (await anySsoAvailable(db(), user.orgId))) {
    attempts.refund(key);
    return { ok: false, error: "Sign in with Microsoft or Google: your organisation doesn't use MOSS passwords." };
  }

  if (user.totpSecretRef) {
    if (!totpCode) {
      attempts.refund(key);
      return { ok: false, error: "Enter the code from your authenticator app.", needTotp: true };
    }
    const secret = decryptSecret(config.appKey(), user.id, JSON.parse(user.totpSecretRef));
    if (!acceptTotp(user.id, secret, totpCode)) {
      const r = await fail(user.orgId, user.id, "totp");
      return { ...r, needTotp: true } as LoginResult;
    }
  }

  attempts.clear(key);
  await startSession(user.id);
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.login", details: { ip } });
  return { ok: true };
}

export async function isOwner(userId: string): Promise<boolean> {
  const rows = await db().select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId));
  return rows.some((r) => r.key === "owner");
}

// The last time step each person's code was accepted at, so a code works only once. In memory, like the throttle.
const usedTotpSteps = new Map<string, number>();

function acceptTotp(userId: string, secret: string, code: string): boolean {
  const step = totpStep(secret, code.replace(/\s/g, ""));
  if (step === null || step <= (usedTotpSteps.get(userId) ?? -1)) return false;
  usedTotpSteps.set(userId, step);
  return true;
}

/**
 * Checks a code from someone's authenticator app (for steps that need a fresh one, like downloading a MOSS backup).
 * Throttled per person like signing in, so a stolen session can't guess its way through.
 */
export async function verifyUserTotp(userId: string, code: string): Promise<boolean> {
  const key = `totp|${userId}`;
  if (!attempts.take(key)) throw new Error(TOO_MANY);
  const [row] = await db().select({ ref: users.totpSecretRef }).from(users).where(eq(users.id, userId));
  if (row?.ref && acceptTotp(userId, decryptSecret(config.appKey(), userId, JSON.parse(row.ref)), code)) {
    attempts.clear(key);
    return true;
  }
  return false;
}

export function sealTotpSecret(userId: string, secret: string): string {
  return JSON.stringify(encryptSecret(config.appKey(), userId, secret));
}

/**
 * Re-checks a signed-in person's password before a sensitive step (setting up two-factor, linking a sign-in
 * account, changing the password). Throttled per person like signing in, so a stolen session can't guess it, and
 * failures are audited. False for a wrong password or someone without one.
 */
export async function confirmPassword(user: { id: string; orgId: string }, password: string, step: string): Promise<boolean> {
  const key = `confirm|${user.id}`;
  if (!attempts.take(key)) throw new Error(TOO_MANY);
  const [row] = await db().select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
  if (row?.hash && (await verifyPassword(password, row.hash))) {
    attempts.clear(key);
    return true;
  }
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.password_check_failed", targetType: "user", targetId: user.id, details: { step } });
  return false;
}
