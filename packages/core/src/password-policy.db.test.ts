// The password policy: rules, breach check, history and two-factor.
import { users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "./auth/password.js";
import { DEFAULT_PASSWORD_POLICY, isBreached, mustEnrolTotp, passwordExpired, passwordProblems, setUserPassword } from "./auth/password-policy.js";
import { bootstrapOrg } from "./store/bootstrap.js";
import { setSetting } from "./store/settings-store.js";

describe("password rules", () => {
  it("checks length and the kinds of character asked for", () => {
    expect(passwordProblems(DEFAULT_PASSWORD_POLICY, "short")).toEqual(["use at least 12 characters"]);
    expect(passwordProblems(DEFAULT_PASSWORD_POLICY, "correct horse battery")).toEqual([]);
    const strict = { ...DEFAULT_PASSWORD_POLICY, minLength: 14, requireUpper: true, requireDigit: true, requireSymbol: true };
    expect(passwordProblems(strict, "correct horse battery")).toEqual(["include a capital letter", "include a digit"]);
    expect(passwordProblems(strict, "Correct horse battery 9")).toEqual([]);
  });

  it("asks the breach service about a hash prefix only, and doesn't block when it can't be reached", async () => {
    const sha1 = createHash("sha1").update("password123456").digest("hex").toUpperCase();
    let asked = "";
    const lookup = async (prefix: string) => ((asked = prefix), `${sha1.slice(5)}:4231\r\nAAAAA:0`);
    expect(await isBreached("password123456", lookup)).toBe(true);
    expect(asked).toBe(sha1.slice(0, 5));
    expect(await isBreached("a fresh unusual sentence", lookup)).toBe(false);
    expect(await isBreached("password123456", async () => Promise.reject(new Error("offline")))).toBe(false);
  });

  it("knows when a password has expired and who must use two-factor", () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    expect(passwordExpired(DEFAULT_PASSWORD_POLICY, old)).toBe(false);
    expect(passwordExpired({ ...DEFAULT_PASSWORD_POLICY, maxAgeDays: 90 }, old)).toBe(true);
    const admins = { ...DEFAULT_PASSWORD_POLICY, requireTotp: "admins" as const };
    expect(mustEnrolTotp(admins, { totpEnabled: false, hasPassword: true, roles: ["admin"] })).toBe(true);
    expect(mustEnrolTotp(admins, { totpEnabled: false, hasPassword: true, roles: ["viewer"] })).toBe(false);
    expect(mustEnrolTotp({ ...admins, requireTotp: "everyone" }, { totpEnabled: false, hasPassword: false, roles: ["viewer"] })).toBe(false); // SSO
    expect(mustEnrolTotp({ ...admins, requireTotp: "everyone" }, { totpEnabled: true, hasPassword: true, roles: ["viewer"] })).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("password history (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_password_policy"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "the-first-password" }));
  });
  afterAll(() => close?.());

  it("refuses recent passwords when history is on, and records when it changed", async () => {
    await setSetting(db, orgId, "auth.password_policy", { history: 2 });
    await expect(setUserPassword(db, orgId, ownerId, "the-first-password")).rejects.toThrow(/don't reuse one of your last 2/);
    await setUserPassword(db, orgId, ownerId, "the-second-password");
    await setUserPassword(db, orgId, ownerId, "the-third-password");
    await expect(setUserPassword(db, orgId, ownerId, "the-second-password")).rejects.toThrow(/reuse/);
    await setUserPassword(db, orgId, ownerId, "the-first-password"); // three back: allowed again
    const [row] = await db.select().from(users).where(eq(users.id, ownerId));
    expect(await verifyPassword("the-first-password", row!.passwordHash!)).toBe(true);
    expect(Date.now() - row!.passwordChangedAt.getTime()).toBeLessThan(10_000);
    await expect(setUserPassword(db, orgId, ownerId, "short")).rejects.toThrow(/at least 12/);
  });
});
