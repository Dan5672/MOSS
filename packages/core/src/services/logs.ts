// Device logs (syslog through Vector): stored per "syslog" source, linked to the inventory device at the sender's
// address, searched by people and agents, and pruned by the logs.retention_days setting.
import { assets, logEntries, monitorSources, networks, type Database } from "@moss/db";
import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or } from "drizzle-orm";
import { senderAllowed, type LogLine } from "../monitoring/syslog.js";
import { getSetting } from "../store/settings-store.js";
import { loadModule, updateModuleState } from "./modules.js";
import { createMonitorSource, deleteInChunks, type MonitorSource } from "./monitors.js";

/** The org's syslog source, made on first use. The collector signs in with the install's own token, not a source's. */
export async function syslogSource(db: Database, orgId: string): Promise<MonitorSource> {
  const [s] = await db
    .select()
    .from(monitorSources)
    .where(and(eq(monitorSources.orgId, orgId), eq(monitorSources.kind, "syslog")))
    .orderBy(asc(monitorSources.createdAt))
    .limit(1);
  return s ?? (await createMonitorSource(db, orgId, { name: "Device logs", kind: "syslog" }, { type: "system", id: null })).source;
}

/** What Monitoring → Logs shows about the collector: when it last posted, and the senders it refused lately. */
export interface SyslogStatus {
  lastBatchAt: string | null;
  refused: { ip: string; at: string }[];
}

export async function syslogStatus(db: Database, orgId: string): Promise<SyslogStatus> {
  const { state } = await loadModule(db, orgId, "syslog");
  return {
    lastBatchAt: typeof state.lastBatchAt === "string" ? state.lastBatchAt : null,
    refused: Array.isArray(state.refused) ? (state.refused as SyslogStatus["refused"]) : [],
  };
}

/** Drops a sender from the refused list, once it has been accepted. */
export async function forgetRefusedSender(db: Database, orgId: string, ip: string) {
  const { refused } = await syslogStatus(db, orgId);
  await updateModuleState(db, orgId, "syslog", { refused: refused.filter((r) => r.ip !== ip) });
}

/**
 * Stores the lines whose sender is inside an allowed network or the logs.allowed_senders setting (syslog has no
 * authentication, so that is the allowlist). Only TCP lines are linked to a device: a UDP sender is trivial to
 * fake. Returns how many were stored and which senders were refused.
 */
export async function ingestLogs(db: Database, source: MonitorSource, lines: LogLine[], now = new Date()) {
  const rules = [
    ...(await db.select({ cidr: networks.cidr, status: networks.status }).from(networks).where(eq(networks.orgId, source.orgId))),
    ...(await getSetting(db, source.orgId, "logs.allowed_senders")).map((cidr) => ({ cidr, status: "allowed" })),
  ];
  const kept = lines.filter((l) => senderAllowed(l.ip, rules));
  const refused = [...new Set(lines.filter((l) => !kept.includes(l)).map((l) => l.ip))];
  if (kept.length) {
    const ips = [...new Set(kept.filter((l) => l.transport === "tcp").map((l) => l.ip))];
    const devices = await db
      .select({ id: assets.id, ip: assets.primaryIp })
      .from(assets)
      .where(and(eq(assets.orgId, source.orgId), inArray(assets.primaryIp, ips)));
    const assetAt = new Map(devices.map((d) => [d.ip, d.id]));
    await db.insert(logEntries).values(
      kept.map((l) => ({
        orgId: source.orgId,
        sourceId: source.id,
        assetId: (l.transport === "tcp" && assetAt.get(l.ip)) || null,
        receivedAt: now,
        loggedAt: l.loggedAt ?? null,
        sourceIp: l.ip,
        transport: l.transport,
        hostname: l.hostname ?? null,
        app: l.app ?? null,
        severity: l.severity ?? null,
        facility: l.facility ?? null,
        message: l.message,
      })),
    );
    await db.update(monitorSources).set({ lastReceivedAt: now }).where(eq(monitorSources.id, source.id));
  }
  // The newest 20 refused senders, so the owner can accept one from the Logs page (e.g. Docker Desktop's gateway).
  const at = now.toISOString();
  const keptIps = new Set(kept.map((l) => l.ip));
  const before = (await syslogStatus(db, source.orgId)).refused.filter((r) => !refused.includes(r.ip) && !keptIps.has(r.ip));
  await updateModuleState(db, source.orgId, "syslog", { lastBatchAt: at, refused: [...refused.map((ip) => ({ ip, at })), ...before].slice(0, 20) });
  return { stored: kept.length, refused };
}

export interface LogFilter {
  /** Words that must appear in the message, app or hostname (case-insensitive). */
  text?: string;
  assetId?: string;
  ip?: string;
  /** Only this severity and worse (0 emergency … 7 debug). */
  maxSeverity?: number;
  sinceHours?: number;
  limit?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first. */
// shortcut: ILIKE scans every line in the window, fine for a home lab's volume; add pg_trgm if searches get slow.
export async function searchLogs(db: Database, orgId: string, f: LogFilter = {}) {
  const since = new Date(Date.now() - (f.sinceHours ?? 24) * 3_600_000);
  const words = (f.text ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return db
    .select({
      id: logEntries.id,
      receivedAt: logEntries.receivedAt,
      loggedAt: logEntries.loggedAt,
      sourceIp: logEntries.sourceIp,
      transport: logEntries.transport,
      hostname: logEntries.hostname,
      app: logEntries.app,
      severity: logEntries.severity,
      facility: logEntries.facility,
      message: logEntries.message,
      assetId: logEntries.assetId,
      assetName: assets.name,
    })
    .from(logEntries)
    .leftJoin(assets, eq(assets.id, logEntries.assetId))
    .where(
      and(
        eq(logEntries.orgId, orgId),
        gte(logEntries.receivedAt, since),
        f.assetId ? eq(logEntries.assetId, f.assetId) : undefined,
        f.ip ? eq(logEntries.sourceIp, f.ip) : undefined,
        f.maxSeverity === undefined ? undefined : lte(logEntries.severity, f.maxSeverity),
        ...words.map((w) => {
          const p = `%${escapeLike(w)}%`;
          return or(ilike(logEntries.message, p), ilike(logEntries.app, p), ilike(logEntries.hostname, p));
        }),
      ),
    )
    .orderBy(desc(logEntries.receivedAt), desc(logEntries.id))
    .limit(Math.min(f.limit ?? 100, 500));
}

/** Deletes lines older than retentionDays, and the oldest beyond maxRows (so a flood can't fill the disk). */
export async function pruneLogs(db: Database, orgId: string, retentionDays: number, maxRows = Infinity): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const [oldestKept] = Number.isFinite(maxRows)
    ? await db
        .select({ at: logEntries.receivedAt })
        .from(logEntries)
        .where(eq(logEntries.orgId, orgId))
        .orderBy(desc(logEntries.receivedAt))
        .offset(maxRows)
        .limit(1)
    : [];
  return deleteInChunks(db, logEntries, and(eq(logEntries.orgId, orgId), or(lt(logEntries.receivedAt, cutoff), oldestKept && lte(logEntries.receivedAt, oldestKept.at))));
}
