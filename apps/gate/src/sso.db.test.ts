// Signing in with Microsoft through the gate: licensed and switched on, the code exchanged with the stored client
// secret, and the token checked against the provider's keys. Against Postgres with a fake toolbox.
import { bootstrapOrg, encryptSecret, generateMasterKey, saveLicence, saveModule, signLicence } from "@moss/core";
import { secrets, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGate, type Gate } from "./service.js";
import type { ToolboxClient } from "./toolbox-client.js";

const fixtures = join(__dirname, "../../../packages/core/src/fixtures/licence");
process.env.MOSS_LICENCE_EXTRA_PUBLIC_KEY = readFileSync(join(fixtures, "test.pub"), "utf8").trim();

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };

function idToken(claims: Record<string, unknown>) {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}

describe.skipIf(!TEST_DATABASE_URL)("single sign-on (gate)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let gate: Gate;
  let orgId: string;
  let ownerId: string;
  const masterKey = generateMasterKey();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const t = Math.floor(Date.now() / 1000);
  let token = "";
  const toolbox: ToolboxClient = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return tool === "oidc_exchange" ? { ok: true, result: { idToken: token } } : { ok: true, result: { keys: [jwk] } };
    },
  };
  const req = { code: "c0de", redirectUri: "https://moss.acme.test/api/auth/sso/microsoft/callback", codeVerifier: "v".repeat(43) };

  beforeAll(async () => {
    ({ db, close } = await createTestDb("gate_sso"));
    ({ org: { id: orgId }, owner: { id: ownerId } } = await bootstrapOrg(db, { orgName: "Acme", ownerEmail: "o@acme.test", ownerName: "O", ownerPassword: "a-long-test-password" }));
    const id = randomUUID();
    await db.insert(secrets).values({ id, orgId, name: "m365-client-secret", type: "api_token", allowedTools: ["m365_users", "oidc_exchange"], ...encryptSecret(masterKey, id, "the-client-secret") });
    await saveModule(db, orgId, "m365", { enabled: true, config: { fields: { tenantId: TENANT, clientId: CLIENT }, options: { ssoEnabled: true } } }, { type: "user", id: ownerId });
    gate = createGate({ db, masterKey, toolbox });
  });
  afterAll(() => close?.());

  it("needs a business licence", async () => {
    expect(await gate.sso({ orgId, provider: "microsoft", ...req })).toEqual({ ok: false, error: "Signing in with Microsoft isn't switched on" });
    expect(calls).toEqual([]);
  });

  it("exchanges the code with the stored secret and checks the token", async () => {
    const lic = signLicence(
      { v: 1, kid: "test", id: "l1", licensee: "Acme", plan: "business", features: ["m365"], issued: "2030-01-01T00:00:00.000Z", expires: "2099-01-01T00:00:00.000Z" },
      readFileSync(join(fixtures, "test.key"), "utf8"),
    );
    await saveLicence(db, orgId, lic, { type: "user", id: ownerId });
    token = idToken({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: "oid-1", preferred_username: "ann@acme.test", nonce: "n1", iat: t, exp: t + 600 });
    expect(await gate.sso({ orgId, provider: "microsoft", ...req })).toEqual({ ok: true, claims: { provider: "microsoft", id: "oid-1", email: "ann@acme.test", name: undefined, nonce: "n1", tenantId: TENANT } });
    expect(calls[0]).toEqual({ tool: "oidc_exchange", args: { provider: "microsoft", tenantId: TENANT, clientId: CLIENT, clientSecret: "the-client-secret", ...req, timeoutMs: 10000 } });
    expect(calls[1]).toMatchObject({ tool: "oidc_keys", args: { provider: "microsoft", tenantId: TENANT } });
  });

  it("refuses a token for another directory, and Google while it isn't set up", async () => {
    token = idToken({ iss: "https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0", aud: CLIENT, tid: "99999999-2222-3333-4444-555555555555", oid: "x", preferred_username: "x@evil.test", iat: t, exp: t + 600 });
    expect(await gate.sso({ orgId, provider: "microsoft", ...req })).toEqual({ ok: false, error: "That Microsoft account isn't in your organisation's directory" });
    expect(await gate.sso({ orgId, provider: "google", ...req })).toMatchObject({ ok: false, error: "Signing in with Google isn't switched on" });
  });
});
