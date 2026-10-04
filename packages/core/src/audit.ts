// Hash-chained audit entries: each entry's hash covers the previous hash, so any
// edit or deletion in the middle of the log breaks verification from that point on.
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntryInput {
  orgId: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface ChainedAuditEntry extends AuditEntryInput {
  prevHash: string;
  hash: string;
}

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashAuditEntry(prevHash: string, entry: AuditEntryInput): string {
  const { orgId, actorType, actorId, action, targetType, targetId, details, createdAt } = entry;
  const body = canonical({ orgId, actorType, actorId, action, targetType, targetId, details, createdAt });
  return createHash("sha256").update(prevHash).update(body).digest("hex");
}

export function chainAuditEntry(prevHash: string, entry: AuditEntryInput): ChainedAuditEntry {
  return { ...entry, prevHash, hash: hashAuditEntry(prevHash, entry) };
}

/** Returns the index of the first entry that fails verification, or -1 if the chain is intact. */
export function verifyAuditChain(entries: ChainedAuditEntry[], startHash = GENESIS_HASH): number {
  let prev = startHash;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.prevHash !== prev || e.hash !== hashAuditEntry(prev, e)) return i;
    prev = e.hash;
  }
  return -1;
}
