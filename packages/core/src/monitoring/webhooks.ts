// Parsers for monitoring webhooks. Every field here comes from outside MOSS and is untrusted:
// it is length-capped, stripped of control characters, and only ever stored and displayed as data.

export type SourceKind = "uptime_kuma" | "beszel" | "alertmanager" | "generic";
export const SOURCE_KINDS: SourceKind[] = ["uptime_kuma", "beszel", "alertmanager", "generic"];

export interface ParsedAlert {
  /** Stable identity of the external check; one MOSS monitor per key. */
  key: string;
  name: string;
  status: "up" | "down" | "degraded";
  message: string;
  target?: string;
  latencyMs?: number;
}

export type ParseOutcome = { ok: true; alerts: ParsedAlert[]; test?: boolean } | { ok: false; error: string };

export function cleanText(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function alert(a: ParsedAlert): ParsedAlert {
  return {
    key: cleanText(a.key, 200),
    name: cleanText(a.name, 200) || cleanText(a.key, 200),
    status: a.status,
    message: cleanText(a.message, 500),
    ...(a.target ? { target: cleanText(a.target, 255) } : {}),
    ...(typeof a.latencyMs === "number" && Number.isFinite(a.latencyMs) ? { latencyMs: Math.max(0, Math.round(a.latencyMs)) } : {}),
  };
}

/** Uptime Kuma "Webhook" notification (JSON body): { heartbeat, monitor, msg }. */
function parseUptimeKuma(body: Record<string, unknown>): ParseOutcome {
  const heartbeat = obj(body.heartbeat);
  const monitor = obj(body.monitor);
  // "Test" button in Uptime Kuma sends both as null.
  if (!heartbeat && !monitor && typeof body.msg === "string") return { ok: true, alerts: [], test: true };
  if (!heartbeat || !monitor) return { ok: false, error: "Expected heartbeat and monitor objects" };
  // 0 down, 1 up, 2 pending, 3 maintenance
  const code = Number(heartbeat.status);
  if (code === 2 || code === 3) return { ok: true, alerts: [] };
  if (code !== 0 && code !== 1) return { ok: false, error: "Unknown heartbeat status" };
  const id = monitor.id ?? heartbeat.monitorID;
  if (id === undefined) return { ok: false, error: "Missing monitor id" };
  const target = monitor.url && monitor.url !== "https://" ? monitor.url : monitor.hostname;
  return {
    ok: true,
    alerts: [
      alert({
        key: `kuma:${String(id)}`,
        name: String(monitor.name ?? `Uptime Kuma monitor ${String(id)}`),
        status: code === 1 ? "up" : "down",
        message: String(heartbeat.msg ?? body.msg ?? ""),
        target: target ? String(target) : undefined,
        latencyMs: typeof heartbeat.ping === "number" ? heartbeat.ping : undefined,
      }),
    ],
  };
}

/**
 * Beszel sends alerts through shoutrrr. Point a "generic" webhook at MOSS with template=json,
 * which posts { title, message }. Titles look like "Connection to nas is down" or
 * "nas Disk usage above threshold".
 */
function parseBeszel(body: Record<string, unknown>): ParseOutcome {
  const title = cleanText(body.title ?? body.subject, 300);
  const message = cleanText(body.message ?? body.body ?? "", 500);
  if (!title) return { ok: false, error: "Expected a title (use shoutrrr generic with template=json)" };
  const conn = /^connection to (.+?) is (down|up)\b/i.exec(title);
  if (conn) {
    return { ok: true, alerts: [alert({ key: `beszel:${conn[1]!.toLowerCase()}:status`, name: `${conn[1]} status`, status: conn[2]!.toLowerCase() as "up" | "down", message: message || title, target: conn[1] })] };
  }
  const threshold = /^(.+?)\s+(.+?)\s+(above|below)\s+threshold\b/i.exec(title);
  if (threshold) {
    const [, system, metric, direction] = threshold;
    return {
      ok: true,
      alerts: [
        alert({
          key: `beszel:${system!.toLowerCase()}:${metric!.toLowerCase().replace(/\s+/g, "_")}`,
          name: `${system} ${metric}`,
          // A metric monitor is "down" while its threshold is exceeded.
          status: direction!.toLowerCase() === "above" ? "down" : "up",
          message: message || title,
          target: system,
        }),
      ],
    };
  }
  return { ok: false, error: "Unrecognised Beszel alert title" };
}

/** Prometheus Alertmanager webhook (version 4). */
function parseAlertmanager(body: Record<string, unknown>): ParseOutcome {
  if (!Array.isArray(body.alerts)) return { ok: false, error: "Expected an alerts array" };
  const alerts: ParsedAlert[] = [];
  for (const raw of body.alerts.slice(0, 100)) {
    const a = obj(raw);
    if (!a) continue;
    const labels = obj(a.labels) ?? {};
    const annotations = obj(a.annotations) ?? {};
    const alertname = String(labels.alertname ?? "alert");
    const instance = labels.instance ? String(labels.instance) : undefined;
    const severity = String(labels.severity ?? "").toLowerCase();
    const firing = String(a.status ?? body.status) === "firing";
    alerts.push(
      alert({
        key: `am:${alertname}:${instance ?? String(a.fingerprint ?? "")}`,
        name: instance ? `${alertname} on ${instance}` : alertname,
        status: !firing ? "up" : severity === "warning" || severity === "info" ? "degraded" : "down",
        message: String(annotations.summary ?? annotations.description ?? alertname),
        target: instance,
      }),
    );
  }
  return { ok: true, alerts };
}

/** Anything else: { key, name?, status: up|down|degraded, message? } or { alerts: [...] } of those. */
function parseGeneric(body: Record<string, unknown>): ParseOutcome {
  const items = Array.isArray(body.alerts) ? body.alerts : [body];
  const alerts: ParsedAlert[] = [];
  for (const raw of items.slice(0, 100)) {
    const a = obj(raw);
    const status = String(a?.status ?? "").toLowerCase();
    if (!a || !a.key || !["up", "down", "degraded"].includes(status)) {
      return { ok: false, error: 'Each alert needs "key" and "status" (up, down or degraded)' };
    }
    alerts.push(alert({ key: `generic:${String(a.key)}`, name: String(a.name ?? a.key), status: status as ParsedAlert["status"], message: String(a.message ?? ""), target: a.target ? String(a.target) : undefined }));
  }
  return { ok: true, alerts };
}

export function parseWebhook(kind: SourceKind, body: unknown): ParseOutcome {
  const b = obj(body);
  if (!b) return { ok: false, error: "Expected a JSON object" };
  switch (kind) {
    case "uptime_kuma":
      return parseUptimeKuma(b);
    case "beszel":
      return parseBeszel(b);
    case "alertmanager":
      return parseAlertmanager(b);
    case "generic":
      return parseGeneric(b);
  }
}
