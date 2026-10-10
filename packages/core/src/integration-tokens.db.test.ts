// Tokens for the Home Assistant integration against Postgres.
import { auditLog, integrationTokens, users, type Database } from "@moss/db";
import { createTestDb, TEST_DATABASE_URL } from "@moss/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrationToken, listIntegrationTokens, revokeIntegrationToken, verifyIntegrationToken } from "./services/integration-tokens.js";
import { bootstrapOrg } from "./store/bootstrap.js";

describe.skipIf(!TEST_DATABASE_URL)("integration tokens (postgres)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb("core_integration_tokens"));
    const boot = await bootstrapOrg(db, { orgName: "Home", ownerEmail: "o@h.test", ownerName: "O", ownerPassword: "a-long-test-password" });
    orgId = boot.org.id;
    ownerId = boot.owner.id;
  });
  afterAll(async () => close?.());

  it("is shown once, kept only as a hash, acts as its maker, and stops working when revoked", async () => {
    const { id, token } = await createIntegrationToken(db, orgId, ownerId, "Kitchen tablet HA");
    expect(token).toMatch(/^moss_ha_[A-Za-z0-9_-]{40,}$/);
    const [row] = await db.select().from(integrationTokens).where(eq(integrationTokens.id, id));
    expect(row!.tokenHash).not.toContain(token.slice(8));
    expect(await verifyIntegrationToken(db, token)).toEqual({ tokenId: id, tokenName: "Kitchen tablet HA", orgId, userId: ownerId });
    expect(await verifyIntegrationToken(db, `${token}x`)).toBeNull();
    expect(await verifyIntegrationToken(db, "not-a-token")).toBeNull();
    expect((await listIntegrationTokens(db, orgId)).map((t) => t.name)).toEqual(["Kitchen tablet HA"]);

    // A disabled maker's tokens stop working too.
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, ownerId));
    expect(await verifyIntegrationToken(db, token)).toBeNull();
    await db.update(users).set({ status: "active" }).where(eq(users.id, ownerId));

    await revokeIntegrationToken(db, orgId, id, ownerId);
    expect(await verifyIntegrationToken(db, token)).toBeNull();
    expect(await listIntegrationTokens(db, orgId)).toEqual([]);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.targetId, id))).map((a) => a.action);
    expect(audits).toEqual(["integration_token.create", "integration_token.revoke"]);
  });
});
