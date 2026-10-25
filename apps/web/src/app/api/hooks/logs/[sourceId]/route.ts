// Device logs from the Vector collector (deploy/vector/vector.yaml), for a "syslog" source. Same token check as
// the monitoring webhooks, with room for batches. Lines are untrusted; the parser caps and cleans every field, and
// only senders inside an allowed network are stored.
import { authenticateMonitorSource, ingestLogs, isModuleEnabled, parseLogBatch } from "@moss/core";
import type { NextRequest } from "next/server";
import { db } from "@/server/db";

const MAX_BODY = 1024 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 300;
// 500 lines a second, the collector's own total throttle (vector.yaml), so a token holder can't go faster.
const MAX_LINES_PER_WINDOW = 30_000;
const usage = new Map<string, { start: number; requests: number; lines: number }>();

function usageOf(key: string) {
  const now = Date.now();
  let u = usage.get(key);
  if (!u || now - u.start > WINDOW_MS) usage.set(key, (u = { start: now, requests: 0, lines: 0 }));
  return u;
}

const error = (status: number, message: string) => Response.json({ ok: false, error: message }, { status });

export async function POST(request: NextRequest, ctx: RouteContext<"/api/hooks/logs/[sourceId]">) {
  const { sourceId } = await ctx.params;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return error(401, "Missing token");
  const source = await authenticateMonitorSource(db(), sourceId, token);
  if (!source || source.kind !== "syslog") return error(401, "Unknown source or wrong token");
  // 403, not 5xx: the collector drops the batch rather than retrying it into its buffer.
  if (!(await isModuleEnabled(db(), source.orgId, "syslog"))) return error(403, "Device logs are switched off (Settings → Integrations)");
  const used = usageOf(source.id);
  if (++used.requests > MAX_PER_WINDOW) return error(429, "Too many requests");

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return error(413, "Payload too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return error(413, "Payload too large");

  const parsed = parseLogBatch(text);
  if (!parsed.ok) return error(400, parsed.error);
  if (used.lines + parsed.lines.length > MAX_LINES_PER_WINDOW) return error(429, "Too many lines");
  used.lines += parsed.lines.length;
  const result = await ingestLogs(db(), source, parsed.lines);
  if (result.refused.length) {
    console.warn(JSON.stringify({ msg: "syslog senders outside allowed networks", sourceId, senders: result.refused.slice(0, 10) }));
  }
  return Response.json({ ok: true, stored: result.stored, dropped: parsed.dropped, refused: result.refused.length });
}
