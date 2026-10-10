// The password policy: minimum length, required kinds of character, no reusing recent passwords, a maximum
// age, required two-factor, and an optional check against known-breached passwords. Set in Settings →
// Security; enforced wherever a password is set. People who sign in with SSO have no MOSS password and are
// left out of the password rules and of required two-factor (their identity provider handles both).
import { passwordHistory, users, type Database } from "@moss/db";
import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getSetting } from "../store/settings-store.js";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password.js";

export const passwordPolicySchema = z.object({
  minLength: z.number().int().min(MIN_PASSWORD_LENGTH).max(128).default(MIN_PASSWORD_LENGTH),
  requireLower: z.boolean().default(false),
  requireUpper: z.boolean().default(false),
  requireDigit: z.boolean().default(false),
  requireSymbol: z.boolean().default(false),
  /** Refuse the last N passwords (0 = no history). */
  history: z.number().int().min(0).max(24).default(0),
  /** Days before a password must be changed (0 = never). */
  maxAgeDays: z.number().int().min(0).max(3650).default(0),
  /** Who must use two-factor sign-in. */
  requireTotp: z.enum(["none", "admins", "everyone"]).default("none"),
  /** Refuse passwords found in known breaches (Have I Been Pwned's range API; the password never leaves). */
  checkBreached: z.boolean().default(false),
});
export type PasswordPolicy = z.infer<typeof passwordPolicySchema>;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = passwordPolicySchema.parse({});

export async function getPasswordPolicy(db: Database, orgId: string): Promise<PasswordPolicy> {
  const parsed = passwordPolicySchema.safeParse(await getSetting(db, orgId, "auth.password_policy"));
  return parsed.success ? parsed.data : DEFAULT_PASSWORD_POLICY;
}

/** Plain-language rules, for forms. */
export function describePolicy(p: PasswordPolicy): string {
  const kinds = [p.requireLower && "a lowercase letter", p.requireUpper && "a capital", p.requireDigit && "a digit", p.requireSymbol && "a symbol"].filter(Boolean);
  return `At least ${p.minLength} characters${kinds.length ? `, with ${kinds.join(", ")}` : ""}.`;
}

/** What's wrong with a password under the policy (empty: it's fine). Doesn't check history or breaches. */
export function passwordProblems(p: PasswordPolicy, password: string): string[] {
  const out: string[] = [];
  if (password.length < p.minLength) out.push(`use at least ${p.minLength} characters`);
  if (password.length > 200) out.push("use at most 200 characters");
  if (p.requireLower && !/[a-z]/.test(password)) out.push("include a lowercase letter");
  if (p.requireUpper && !/[A-Z]/.test(password)) out.push("include a capital letter");
  if (p.requireDigit && !/[0-9]/.test(password)) out.push("include a digit");
  if (p.requireSymbol && !/[^A-Za-z0-9]/.test(password)) out.push("include a symbol");
  return out;
}

export type BreachLookup = (sha1Prefix: string) => Promise<string>;

/** Have I Been Pwned's range API: only the first 5 characters of the password's SHA-1 are sent. */
export const hibpLookup: BreachLookup = async (prefix) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

/** True if the password is in a known breach. If the service can't be reached, it isn't counted against you. */
export async function isBreached(password: string, lookup: BreachLookup = hibpLookup): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  try {
    const body = await lookup(sha1.slice(0, 5));
    return body.split("\n").some((line) => {
      const [suffix, count] = line.trim().split(":");
      return suffix === sha1.slice(5) && Number(count) > 0;
    });
  } catch {
    return false;
  }
}

export class PasswordPolicyError extends Error {}

/** Checks a new password against the policy (and, for an existing person, their history). Throws with every problem. */
export async function checkNewPassword(db: Database, policy: PasswordPolicy, password: string, userId?: string, lookup?: BreachLookup) {
  const problems = passwordProblems(policy, password);
  if (userId && policy.history > 0) {
    const [current] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
    const old = await db.select({ hash: passwordHistory.passwordHash }).from(passwordHistory).where(eq(passwordHistory.userId, userId)).orderBy(desc(passwordHistory.createdAt)).limit(policy.history);
    for (const h of [current?.hash, ...old.map((o) => o.hash)].filter((x): x is string => !!x).slice(0, policy.history)) {
      if (await verifyPassword(password, h)) {
        problems.push(`don't reuse one of your last ${policy.history} passwords`);
        break;
      }
    }
  }
  if (!problems.length && policy.checkBreached && (await isBreached(password, lookup))) {
    problems.push("choose another: this one appears in known data breaches");
  }
  if (problems.length) throw new PasswordPolicyError(`Password: ${problems.join("; ")}.`);
}

/** Sets a person's password under the policy, keeping the old one in their history. */
export async function setUserPassword(db: Database, orgId: string, userId: string, password: string, lookup?: BreachLookup) {
  const policy = await getPasswordPolicy(db, orgId);
  await checkNewPassword(db, policy, password, userId, lookup);
  const [current] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    if (current?.hash) await tx.insert(passwordHistory).values({ userId, passwordHash: current.hash });
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, userId));
  });
}

/** Whether a password has outlived the policy's maximum age. */
export function passwordExpired(policy: PasswordPolicy, changedAt: Date, now = new Date()): boolean {
  return policy.maxAgeDays > 0 && now.getTime() - changedAt.getTime() > policy.maxAgeDays * 86_400_000;
}

/** Whether this person must set up two-factor before using MOSS (SSO users are exempt). */
export function mustEnrolTotp(policy: PasswordPolicy, person: { totpEnabled: boolean; hasPassword: boolean; roles: string[] }): boolean {
  if (person.totpEnabled || !person.hasPassword) return false;
  if (policy.requireTotp === "everyone") return true;
  return policy.requireTotp === "admins" && person.roles.some((r) => r === "owner" || r === "admin");
}
