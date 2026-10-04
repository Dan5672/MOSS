// Appends to the hash-chained audit log. A per-org advisory lock serializes writers
// so concurrent agents cannot fork the chain.
import { auditLog, type Database } from "@moss/db";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { chainAuditEntry, GENESIS_HASH, verifyAuditChain, type AuditEntryInput } from "../audit.js";

export interface AuditEvent {
  orgId: string;
  siteId?: string | null;
  actorType: AuditEntryInput["actorType"];
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export async function writeAudit(db: Database, event: AuditEvent): Promise<{ id: number; hash: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"audit:" + event.orgId}))`);
    const [last] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.orgId, event.orgId))
      .orderBy(desc(auditLog.id))
      .limit(1);
    const entry = chainAuditEntry(last?.hash ?? GENESIS_HASH, {
      orgId: event.orgId,
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      details: event.details ?? {},
      createdAt: new Date(),
    });
    const [row] = await tx
      .insert(auditLog)
      .values({ ...entry, siteId: event.siteId ?? null })
      .returning({ id: auditLog.id, hash: auditLog.hash });
    return row!;
  });
}

/** Verifies the whole chain for an org. Returns the id of the first bad entry, or null if intact. */
export async function verifyAuditLog(db: Database, orgId: string, batchSize = 5000): Promise<number | null> {
  let prev = GENESIS_HASH;
  let afterId = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, orgId), gt(auditLog.id, afterId)))
      .orderBy(asc(auditLog.id))
      .limit(batchSize);
    if (rows.length === 0) return null;
    const bad = verifyAuditChain(rows, prev);
    if (bad !== -1) return rows[bad]!.id;
    prev = rows[rows.length - 1]!.hash;
    afterId = rows[rows.length - 1]!.id;
  }
}
