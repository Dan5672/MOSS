// Config backups: the gate is the only service with the master key, so it encrypts what config_backup
// copied and decrypts it again for a person's download. Agents only ever see a backup's metadata.
import { decryptSecret, encryptSecret, writeAudit } from "@moss/core";
import { configBackups, users, type Database } from "@moss/db";
import type { ConfigBackupFile } from "@moss/tools";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/** Backups kept per device, source and file; older ones are deleted when a new one is stored. */
export const BACKUPS_KEPT = 20;

/** Distinct encryption context, so a backup's ciphertext can never be opened as a secret (or vice versa). */
const context = (id: string) => `backup:${id}`;

export async function storeBackup(
  db: Database,
  masterKey: Buffer,
  where: { orgId: string; siteId: string | null; agentId: string; runId?: string },
  file: ConfigBackupFile,
) {
  if (!file.contentBase64) throw new Error("The backup has no content");
  const id = randomUUID();
  const sealed = encryptSecret(masterKey, context(id), file.contentBase64);
  await db.insert(configBackups).values({
    id,
    orgId: where.orgId,
    siteId: where.siteId,
    target: file.target,
    source: file.source,
    filename: file.filename,
    contentType: file.contentType,
    bytes: file.bytes,
    sha256: file.sha256,
    ...sealed,
    agentId: where.agentId,
    runId: where.runId ?? null,
  });

  const same = and(eq(configBackups.orgId, where.orgId), eq(configBackups.target, file.target), eq(configBackups.source, file.source), eq(configBackups.filename, file.filename));
  const keep = await db.select({ id: configBackups.id }).from(configBackups).where(same).orderBy(desc(configBackups.createdAt)).limit(BACKUPS_KEPT);
  await db.delete(configBackups).where(and(same, notInArray(configBackups.id, keep.map((k) => k.id))));

  return { backupId: id, target: file.target, source: file.source, filename: file.filename, bytes: file.bytes, sha256: file.sha256, stored: true };
}

/** Decrypts a backup for a person's download, and audits it. Returns null if it doesn't exist in their org. */
export async function readBackup(db: Database, masterKey: Buffer, backupId: string, userId: string) {
  const [user] = await db.select({ id: users.id, orgId: users.orgId, status: users.status }).from(users).where(eq(users.id, userId));
  if (!user || user.status !== "active") return null;
  const [row] = await db.select().from(configBackups).where(and(eq(configBackups.id, backupId), eq(configBackups.orgId, user.orgId)));
  if (!row) return null;
  const content = Buffer.from(decryptSecret(masterKey, context(row.id), row), "base64");
  await writeAudit(db, {
    orgId: row.orgId,
    actorType: "user",
    actorId: user.id,
    action: "backup.download",
    targetType: "config_backup",
    targetId: row.id,
    details: { target: row.target, source: row.source, filename: row.filename, sha256: row.sha256 },
  });
  return { filename: row.filename, contentType: row.contentType, content };
}
