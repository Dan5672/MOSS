// Batches of syslog lines from the Vector collector (deploy/vector/vector.yaml), which turns each line into
// { ip, transport, hostname, app, severity, facility, at, message }. Only ip and transport are Vector's own
// observation (the packet's sender, trivial to fake over UDP); the rest is whatever the device, or anyone
// spoofing it, put in the line. All of it is capped and
// cleaned here, and only ever stored and shown as data.
import { canonicalAddress, contains, overlaps, parseRange } from "@moss/policy";
import { cleanText } from "./webhooks.js";

export const MAX_LOG_LINES = 1000;
const MAX_MESSAGE = 2000;
const SEVERITY_NAMES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"];

export interface LogLine {
  ip: string;
  transport: "tcp" | "udp";
  hostname?: string;
  app?: string;
  /** 0 emergency … 7 debug. */
  severity?: number;
  facility?: string;
  loggedAt?: Date;
  message: string;
}

export type LogBatch = { ok: true; lines: LogLine[]; dropped: number } | { ok: false; error: string };

function severity(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7) return v;
  const i = typeof v === "string" ? SEVERITY_NAMES.indexOf(v.toLowerCase()) : -1;
  return i >= 0 ? i : undefined;
}

// Device clocks are often wrong or yearless; anything more than a day off from now is dropped rather than shown.
function loggedAt(v: unknown, now: number): Date | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && Math.abs(t - now) < 86_400_000 ? new Date(t) : undefined;
}

const optional = (v: unknown, max: number) => cleanText(v, max) || undefined;

/** Parses Vector's JSON array (or newline-delimited JSON). Lines without a valid sender or a message are dropped. */
export function parseLogBatch(text: string, now = Date.now()): LogBatch {
  let items: unknown[];
  try {
    const trimmed = text.trim();
    items = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { ok: false, error: "Body must be a JSON array or newline-delimited JSON" };
  }
  if (!Array.isArray(items)) return { ok: false, error: "Body must be a JSON array or newline-delimited JSON" };
  if (items.length > MAX_LOG_LINES) return { ok: false, error: `At most ${MAX_LOG_LINES} lines per request` };
  const lines: LogLine[] = [];
  for (const raw of items) {
    const e = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const ip = typeof e?.ip === "string" ? canonicalAddress(e.ip) : null;
    const message = cleanText(e?.message, MAX_MESSAGE);
    if (!e || !ip || !message) continue;
    lines.push({
      ip,
      transport: e.transport === "tcp" ? "tcp" : "udp",
      hostname: optional(e.hostname, 255),
      app: optional(e.app, 100),
      severity: severity(e.severity),
      facility: optional(e.facility, 20),
      loggedAt: loggedAt(e.at, now),
      message,
    });
  }
  return { ok: true, lines, dropped: items.length - lines.length };
}

/** A sender is accepted only from inside an allowed network, and never from one that overlaps an off-limits network. */
export function senderAllowed(ip: string, rules: { cidr: string; status: string }[]): boolean {
  const addr = parseRange(ip);
  if (!addr) return false;
  const ranges = rules.flatMap((rule) => {
    const range = parseRange(rule.cidr);
    return range ? [{ status: rule.status, range }] : [];
  });
  if (ranges.some((n) => n.status === "off_limits" && overlaps(n.range, addr))) return false;
  return ranges.some((n) => n.status === "allowed" && contains(n.range, addr));
}
