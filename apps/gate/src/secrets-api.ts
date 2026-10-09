// Write-only secrets API for the web app. Values go in; they never come back out.
// The gate is the only service holding the master key, so encryption happens here.
import { encryptSecret, writeAudit } from "@moss/core";
import { secrets, users, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const secretWriteSchema = z.object({
  userId: z.uuid(),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "Use letters, digits, dot, dash or underscore"),
  type: z.enum(["password", "ssh_key", "api_token", "snmp_community", "other"]),
  value: z.string().min(1).max(64 * 1024),
  username: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  allowedHosts: z.array(z.string().max(64)).max(100).default([]),
  allowedTools: z.array(z.string().max(64)).max(50).default([]),
});

export type SecretWrite = z.infer<typeof secretWriteSchema>;

/** Creates a secret, or rotates the value if one with the same name exists. Returns its id (never the value). */
export async function writeSecret(db: Database, masterKey: Buffer, input: SecretWrite): Promise<{ id: string; created: boolean }> {
  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user || user.status !== "active") throw new Error("Unknown user");
  const orgId = user.orgId;

  const [existing] = await db.select({ id: secrets.id }).from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, input.name)));
  const id = existing?.id ?? randomUUID();
  const encrypted = encryptSecret(masterKey, id, input.value);
  const meta = {
    type: input.type,
    username: input.username ?? null,
    description: input.description ?? null,
    allowedHosts: input.allowedHosts,
    allowedTools: input.allowedTools,
  };
  if (existing) {
    await db
      .update(secrets)
      .set({ ...encrypted, ...meta, lastRotatedAt: new Date(), updatedAt: new Date() })
      .where(eq(secrets.id, id));
  } else {
    await db.insert(secrets).values({ id, orgId, name: input.name, ...encrypted, ...meta });
  }
  await writeAudit(db, {
    orgId,
    actorType: "user",
    actorId: user.id,
    action: existing ? "secret.rotate" : "secret.create",
    targetType: "secret",
    targetId: id,
    details: { name: input.name, ...meta }, // never the value
  });
  return { id, created: !existing };
}
