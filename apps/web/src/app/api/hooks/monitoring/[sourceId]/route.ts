// Inbound monitoring webhooks (Uptime Kuma, Beszel, Alertmanager, generic JSON). No session:
// each source has its own bearer token (or ?token= for senders that can only set a URL).
// Payloads are untrusted; the parsers cap and clean every field before anything is stored.
import { authenticateMonitorSource, ingestAlerts, parseWebhook, type SourceKind } from "@moss/core";
import type { NextRequest } from "next/server";
import { db } from "@/server/db";

const MAX_BODY = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, { start: number; n: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > WINDOW_MS) {
    if (hits.size > 1000) hits.clear();
    hits.set(key, { start: now, n: 1 });
    return false;
  }
  return ++h.n > MAX_PER_WINDOW;
}

const error = (status: number, message: string) => Response.json({ ok: false, error: message }, { status });

export async function POST(request: NextRequest, ctx: RouteContext<"/api/hooks/monitoring/[sourceId]">) {
  const { sourceId } = await ctx.params;
  if (rateLimited(sourceId)) return error(429, "Too many requests");

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : request.nextUrl.searchParams.get("token");
  if (!token) return error(401, "Missing token");
  const source = await authenticateMonitorSource(db(), sourceId, token);
  if (!source) return error(401, "Unknown source or wrong token");

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return error(413, "Payload too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return error(413, "Payload too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error(400, "Body must be JSON");
  }

  const parsed = parseWebhook(source.kind as SourceKind, body);
  if (!parsed.ok) {
    console.warn(JSON.stringify({ msg: "monitoring webhook rejected", sourceId, kind: source.kind, error: parsed.error }));
    return error(400, parsed.error);
  }
  const result = await ingestAlerts(db(), source, parsed.alerts);
  return Response.json({ ok: true, test: parsed.test ?? false, ...result });
}
