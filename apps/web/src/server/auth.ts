import "server-only";
import {
  decryptSecret,
  encryptSecret,
  generateToken,
  hashToken,
  userPermissions,
  verifyPassword,
  verifyTotp,
  writeAudit,
  type Permission,
} from "@moss/core";
import { orgs, sessions, users } from "@moss/db";
import { and, eq, gt } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { config } from "./config";
import { db } from "./db";

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
  permissions: Set<Permission>;
}

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.status !== "active") return null;
  return {
    id: row.user.id,
    orgId: row.user.orgId,
    email: row.user.email,
    displayName: row.user.displayName,
    totpEnabled: !!row.user.totpSecretRef,
    motion: row.user.motion,
    permissions: await userPermissions(db(), row.user.id),
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
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

export async function startSession(userId: string) {
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
    });
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies(),
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

// --- Login throttling: in-memory, per email+IP. Good enough for a single web instance. ---
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function throttleKey(email: string, ip: string | null) {
  return `${email.toLowerCase()}|${ip ?? "?"}`;
}

export type LoginResult = { ok: true } | { ok: false; error: string; needTotp?: boolean };

export async function login(email: string, password: string, totpCode?: string): Promise<LoginResult> {
  const ip = await clientIp();
  const key = throttleKey(email, ip);
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  }
  const fail = async (orgId: string | null, userId: string | null, reason: string): Promise<LoginResult> => {
    const e = attempts.get(key);
    attempts.set(key, e && e.resetAt > now ? { count: e.count + 1, resetAt: e.resetAt } : { count: 1, resetAt: now + WINDOW_MS });
    if (orgId) await writeAudit(db(), { orgId, actorType: "user", actorId: userId, action: "auth.login_failed", details: { email, ip, reason } });
    return { ok: false, error: "Incorrect email, password or code." };
  };

  const [user] = await db().select().from(users).where(eq(users.email, email.toLowerCase()));
  // Verify a password even when the user doesn't exist, so timing doesn't reveal which emails exist.
  const valid = await verifyPassword(password, user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  if (!user || !valid || user.status !== "active") return fail(user?.orgId ?? null, user?.id ?? null, "password");

  if (user.totpSecretRef) {
    if (!totpCode) return { ok: false, error: "Enter the code from your authenticator app.", needTotp: true };
    const secret = decryptSecret(config.appKey(), user.id, JSON.parse(user.totpSecretRef));
    if (!verifyTotp(secret, totpCode.replace(/\s/g, ""))) {
      const r = await fail(user.orgId, user.id, "totp");
      return { ...r, needTotp: true } as LoginResult;
    }
  }

  attempts.delete(key);
  await startSession(user.id);
  await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "auth.login", details: { ip } });
  return { ok: true };
}

export function sealTotpSecret(userId: string, secret: string): string {
  return JSON.stringify(encryptSecret(config.appKey(), userId, secret));
}
