import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth/password.js";
import { BUILT_IN_ROLES, effectivePermissions } from "./auth/rbac.js";
import { generateToken, hashToken } from "./auth/tokens.js";
import { base32Decode, base32Encode, generateTotpSecret, totpCode, verifyTotp } from "./auth/totp.js";

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
});

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000, 8)).toBe("94287082");
    expect(totpCode(secret, 1_111_111_109_000, 8)).toBe("07081804");
    expect(totpCode(secret, 20_000_000_000_000, 8)).toBe("65353130");
  });

  it("round-trips base32", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("verifies codes within one step of drift", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 120_000), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });
});

describe("tokens", () => {
  it("generates prefixed tokens and stable hashes", () => {
    const t = generateToken("mss");
    expect(t).toMatch(/^mss_[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toContain(t);
  });
});

describe("RBAC", () => {
  it("never lets agents hold human-only permissions", () => {
    const perms = effectivePermissions(BUILT_IN_ROLES.owner!.permissions, "agent");
    expect(perms.has("changes.approve")).toBe(false);
    expect(perms.has("networks.manage")).toBe(false);
    expect(perms.has("killswitch.use")).toBe(false);
    expect(perms.has("incidents.manage")).toBe(true);
  });

  it("drops unknown permissions", () => {
    expect([...effectivePermissions(["assets.read", "root.everything"], "user")]).toEqual(["assets.read"]);
  });

  it("gives only change approvers and above the approve permission", () => {
    const approvers = Object.entries(BUILT_IN_ROLES)
      .filter(([, r]) => r.permissions.includes("changes.approve"))
      .map(([k]) => k);
    expect(approvers.sort()).toEqual(["admin", "change_approver", "owner"]);
  });
});
