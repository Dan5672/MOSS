// Tokens for systems that talk to MOSS's integration API (the Home Assistant integration). The token is
// shown once; only its SHA-256 is stored. A token acts for the person who made it, so it can never do
// more than they can, and it stops working if they're disabled or the token is revoked.
import { integrationTokens, users, type Database } from "@moss/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { writeAudit } from "../store/audit-store.js";

const PREFIX = "moss_ha_";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createIntegrationToken(db: Database, orgId: string, userId: string, name: string) {
  const label = name.trim().slice(0, 60) || "Home Assistant";
  const token = PREFIX + randomBytes(32).toString("base64url");
  const [row] = await db.insert(integrationTokens).values({ orgId, kind: "home_assistant", name: label, tokenHash: hash(token), createdByUserId: userId }).returning();
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "integration_token.create", targetType: "integration_token", targetId: row!.id, details: { name: label, kind: "home_assistant" } });
  return { id: row!.id, token };
}

export async function listIntegrationTokens(db: Pick<Database, "select">, orgId: string) {
  return db
    .select({ id: integrationTokens.id, name: integrationTokens.name, createdAt: integrationTokens.createdAt, lastUsedAt: integrationTokens.lastUsedAt, createdBy: users.displayName })
    .from(integrationTokens)
    .innerJoin(users, eq(users.id, integrationTokens.createdByUserId))
    .where(and(eq(integrationTokens.orgId, orgId), isNull(integrationTokens.revokedAt)))
    .orderBy(desc(integrationTokens.createdAt));
}

export async function revokeIntegrationToken(db: Database, orgId: string, tokenId: string, userId: string) {
  const [row] = await db
    .update(integrationTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(integrationTokens.id, tokenId), eq(integrationTokens.orgId, orgId), isNull(integrationTokens.revokedAt)))
    .returning();
  if (!row) throw new Error("Token not found");
  await writeAudit(db, { orgId, actorType: "user", actorId: userId, action: "integration_token.revoke", targetType: "integration_token", targetId: row.id, details: { name: row.name } });
}

export interface IntegrationCaller {
  tokenId: string;
  tokenName: string;
  orgId: string;
  userId: string;
}

/** The caller behind a bearer token, or null. Notes when it was last used (at most once a minute). */
export async function verifyIntegrationToken(db: Database, token: string | null | undefined): Promise<IntegrationCaller | null> {
  if (!token || !token.startsWith(PREFIX) || token.length > 200) return null;
  const [row] = await db
    .select({ t: integrationTokens, status: users.status })
    .from(integrationTokens)
    .innerJoin(users, eq(users.id, integrationTokens.createdByUserId))
    .where(eq(integrationTokens.tokenHash, hash(token)));
  if (!row || row.t.revokedAt || row.status !== "active") return null;
  if (!row.t.lastUsedAt || Date.now() - row.t.lastUsedAt.getTime() > 60_000) {
    await db.update(integrationTokens).set({ lastUsedAt: new Date() }).where(eq(integrationTokens.id, row.t.id));
  }
  return { tokenId: row.t.id, tokenName: row.t.name, orgId: row.t.orgId, userId: row.t.createdByUserId };
}
