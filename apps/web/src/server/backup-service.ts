// Talking to MOSS's backup service (deploy/backup/moss-backup.mjs): its archives, starting one, deleting one,
// and fetching one encrypted with a passphrase. The web app never sees an archive unencrypted.
import "server-only";
import { randomBytes } from "node:crypto";
import { config } from "./config";

export interface MossBackup {
  name: string;
  bytes: number;
  created: string;
}
export interface BackupServiceStatus {
  backups: MossBackup[];
  running: { startedAt: string; reason: string } | null;
  last: { ok: boolean; at: string; name?: string; bytes?: number; error?: string; reason: string } | null;
}

export const BACKUP_NAME = /^moss-backup-\d{8}T\d{6}Z\.tar\.gz$/;

async function call(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const url = config.backupUrl();
  if (!url) throw new Error("This install has no backup service. Upgrade MOSS to get it.");
  return fetch(`${url.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.backupToken()}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
}

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `The backup service refused (HTTP ${res.status}).`);
}

/** The archives and what the service is doing, or null if it can't be reached. */
export async function backupServiceStatus(): Promise<BackupServiceStatus | null> {
  if (!config.backupUrl()) return null;
  try {
    const res = await call("/backups", {}, 4000);
    return res.ok ? ((await res.json()) as BackupServiceStatus) : null;
  } catch {
    return null;
  }
}

export async function startMossBackup(keep: number): Promise<void> {
  const res = await call("/run", { method: "POST", body: JSON.stringify({ keep, reason: "manual" }) });
  if (!res.ok) throw await failure(res);
}

export async function deleteMossBackup(name: string): Promise<void> {
  if (!BACKUP_NAME.test(name)) throw new Error("No such backup.");
  const res = await call(`/backups/${name}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res);
}

/** The archive, encrypted with the passphrase (openssl enc, which restore.sh undoes), as a stream. */
export async function encryptedBackup(name: string, passphrase: string): Promise<Response> {
  if (!BACKUP_NAME.test(name)) throw new Error("No such backup.");
  const res = await call(`/backups/${name}/download`, { method: "POST", body: JSON.stringify({ passphrase }) }, 10 * 60_000);
  if (!res.ok) throw await failure(res);
  return res;
}

// One-time download tickets: the server action checks the code and passphrase, then the browser fetches the
// file with the ticket (so the download streams). Each works once, for one person, for a minute.
// Kept on globalThis: Next may load this module separately for the action and the route.
type Ticket = { userId: string; name: string; passphrase: string; expires: number };
const tickets: Map<string, Ticket> = ((globalThis as { __mossBackupTickets?: Map<string, Ticket> }).__mossBackupTickets ??= new Map());

export function issueDownloadTicket(userId: string, name: string, passphrase: string): string {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { userId, name, passphrase, expires: now + 60_000 });
  return ticket;
}

export function redeemDownloadTicket(ticket: string, userId: string): { name: string; passphrase: string } | null {
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || t.userId !== userId || t.expires < Date.now()) return null;
  return { name: t.name, passphrase: t.passphrase };
}
