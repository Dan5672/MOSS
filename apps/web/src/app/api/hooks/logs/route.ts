// Device logs from the Vector collector (deploy/vector/vector.yaml). It signs in with the install's syslog token
// (deploy/secrets/syslog.token, made by init.sh), so switching Device logs on is all the setup MOSS needs. Lines are
// untrusted; the parser caps and cleans every field, and only senders inside an allowed network are stored.
import { ingestLogs, orgsWithModule, parseLogBatch, syslogSource } from "@moss/core";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { config } from "@/server/config";
import { db } from "@/server/db";

const COLLECTOR_HOST = "web:3000";
const MAX_BODY = 1024 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 300;
// 500 lines a second, the collector's own total throttle (vector.yaml), so a token holder can't go faster.
const MAX_LINES_PER_WINDOW = 30_000;
let usage = { start: 0, requests: 0, lines: 0 };

const error = (status: number, message: string) => Response.json({ ok: false, error: message }, { status });
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(request: NextRequest) {
  // Only the collector, which posts to http://web:3000 on the internal syslog network. Through Caddy or Tailscale
  // the Host is MOSS's public name, and a token holder there could claim lines came over TCP from any device.
  // shortcut: a LAN client reaching web:3000 directly (MOSS_WEB_BIND) can still send this Host; that needs the token too.
  if (request.headers.get("host") !== COLLECTOR_HOST) return error(404, "Not found");
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const expected = config.syslogToken();
  if (!token || !expected || !timingSafeEqual(digest(token), digest(expected))) return error(401, "Wrong token");
  // 403, not 5xx: the collector drops the batch rather than retrying it into its buffer.
  // shortcut: MOSS has one org per install; with several, the collector would need one token each.
  const [orgId] = await orgsWithModule(db(), "syslog");
  if (!orgId) return error(403, "Device logs are switched off (Monitoring → Logs)");
  const source = await syslogSource(db(), orgId);
  if (!source.enabled) return error(403, "The Device logs source is disabled (Monitoring → Webhook sources)");
  const now = Date.now();
  if (now - usage.start > WINDOW_MS) usage = { start: now, requests: 0, lines: 0 };
  if (++usage.requests > MAX_PER_WINDOW) return error(429, "Too many requests");

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return error(413, "Payload too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return error(413, "Payload too large");

  const parsed = parseLogBatch(text);
  if (!parsed.ok) return error(400, parsed.error);
  if (usage.lines + parsed.lines.length > MAX_LINES_PER_WINDOW) return error(429, "Too many lines");
  usage.lines += parsed.lines.length;
  const result = await ingestLogs(db(), source, parsed.lines);
  return Response.json({ ok: true, stored: result.stored, dropped: parsed.dropped, refused: result.refused.length });
}
