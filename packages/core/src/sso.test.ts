// Single sign-on: ID tokens from Microsoft and Google, checked, and matched to people already in MOSS.
import { users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ssoAuthorizeUrl, ssoStart, ssoUser, verifyIdToken, type SsoClient } from "./auth/sso.js";
import { bootstrapOrg } from "./store/bootstrap.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };
const now = new Date("2030-01-01T00:00:00Z");
const t = now.getTime() / 1000;

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "k1") {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
}

const TENANT = "11111111-2222-3333-4444-555555555555";
const ms: SsoClient = { provider: "microsoft", clientId: "app-1", tenantId: TENANT };
const google: SsoClient = { provider: "google", clientId: "g-1.apps.googleusercontent.com", domains: ["acme.test"] };
const msClaims = { iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: "app-1", tid: TENANT, oid: "oid-1", preferred_username: "Ann@Acme.test", name: "Ann", nonce: "n1", iat: t, exp: t + 3600 };
const gClaims = { iss: "https://accounts.google.com", aud: google.clientId, sub: "g-sub-1", email: "bob@acme.test", email_verified: true, hd: "acme.test", nonce: "n2", iat: t, exp: t + 3600 };

describe("ID tokens", () => {
  it("accepts Microsoft's, for people in your directory", () => {
    expect(verifyIdToken(jwt(msClaims), jwks, ms, now)).toEqual({ provider: "microsoft", id: "oid-1", email: "ann@acme.test", name: "Ann", nonce: "n1", tenantId: TENANT });
    expect(() => verifyIdToken(jwt({ ...msClaims, tid: "99999999-2222-3333-4444-555555555555" }), jwks, ms, now)).toThrow(/isn't in your organisation's directory/);
    expect(() => verifyIdToken(jwt({ ...msClaims, iss: "https://evil.test/v2.0" }), jwks, ms, now)).toThrow(/wasn't issued by Microsoft/);
  });

  it("accepts Google's, for verified emails in your domains", () => {
    expect(verifyIdToken(jwt(gClaims), jwks, google, now)).toMatchObject({ provider: "google", id: "g-sub-1", email: "bob@acme.test" });
    expect(() => verifyIdToken(jwt({ ...gClaims, email_verified: false }), jwks, google, now)).toThrow(/isn't verified/);
    expect(() => verifyIdToken(jwt({ ...gClaims, hd: undefined }), jwks, google, now)).toThrow(/isn't in one of your organisation's domains/);
    expect(() => verifyIdToken(jwt({ ...gClaims, hd: "other.test" }), jwks, google, now)).toThrow(/domains/);
  });

  it("refuses forged, foreign, stale and misdirected tokens", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => verifyIdToken(jwt(msClaims, other), jwks, ms, now)).toThrow(/signature doesn't match/);
    expect(() => verifyIdToken(jwt(msClaims, privateKey, "k9"), jwks, ms, now)).toThrow(/key the provider doesn't publish/);
    expect(() => verifyIdToken(jwt({ ...msClaims, aud: "someone-else" }), jwks, ms, now)).toThrow(/another application/);
    expect(() => verifyIdToken(jwt({ ...msClaims, exp: t - 600 }), jwks, ms, now)).toThrow(/expired/);
    const [h, b] = jwt(msClaims).split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${b}.`;
    expect(() => verifyIdToken(none, jwks, ms, now)).toThrow(/isn't signed the expected way/);
    expect(() => verifyIdToken(`${h}.${b}`, jwks, ms, now)).toThrow(/malformed/);
  });
});

describe("starting a sign-in", () => {
  it("sends PKCE, the state and nonce, and for Google the domain hint", () => {
    const s = ssoStart();
    expect(s.challenge).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
    const url = new URL(ssoAuthorizeUrl(google, { redirectUri: "https://moss.acme.test/api/auth/sso/google/callback", ...s }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: google.clientId, response_type: "code", state: s.state, nonce: s.nonce, code_challenge_method: "S256", hd: "acme.test" });
    expect(new URL(ssoAuthorizeUrl(ms, { redirectUri: "https://x/cb", ...s })).pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("matching people (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_sso"));
    orgId = (await bootstrapOrg(db, { orgName: "Acme", ownerEmail: "owner@acme.test", ownerName: "O", ownerPassword: "a-long-test-password" })).org.id;
    await db.insert(users).values([
      { orgId, email: "Ann@acme.test", displayName: "Ann" },
      { orgId, email: "gone@acme.test", displayName: "Gone", status: "disabled" },
    ]);
  });
  afterAll(async () => close?.());

  it("links people by email the first time, by their account after, and refuses everyone else", async () => {
    const claims = verifyIdToken(jwt(msClaims), jwks, ms, now);
    const ann = await ssoUser(db, orgId, claims);
    expect(ann).toMatchObject({ email: "Ann@acme.test", oidcSubject: `microsoft:${TENANT}:oid-1`, status: "active" });
    // A changed email at the provider still signs in the same person.
    expect((await ssoUser(db, orgId, { ...claims, email: "ann.new@acme.test" })).id).toBe(ann.id);
    // Another account with Ann's email can't take over her linked user.
    await expect(ssoUser(db, orgId, { ...claims, id: "oid-other" })).rejects.toThrow(/ann@acme.test isn't in MOSS/);
    await expect(ssoUser(db, orgId, { ...claims, id: "oid-2", email: "stranger@acme.test" })).rejects.toThrow(/isn't in MOSS/);
    await expect(ssoUser(db, orgId, { ...claims, id: "oid-3", email: "gone@acme.test" })).rejects.toThrow(/isn't in MOSS/);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, ann.id));
    await expect(ssoUser(db, orgId, claims)).rejects.toThrow(/disabled/);
  });
});
