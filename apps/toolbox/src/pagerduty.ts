// PagerDuty: events (trigger and resolve pages; change events for testing) with a service's integration key, and
// the recent incidents MOSS raised, read with a read-only REST API key.
import { clean } from "./parsers.js";

export class PagerDutyError extends Error {}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];

async function enqueue(f: Fetch, path: string, body: unknown, timeoutMs: number) {
  const res = await f(`https://events.pagerduty.com${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const reply = obj(await res.json().catch(() => ({})));
  if (res.status === 429) throw new PagerDutyError("PagerDuty is limiting events: try again shortly");
  if (res.status !== 202) throw new PagerDutyError(`PagerDuty refused the event: ${Array.isArray(reply.errors) && reply.errors.length ? reply.errors.map(String).join("; ") : (clean(reply.message) ?? `HTTP ${res.status}`)}`);
  return { status: clean(reply.status) ?? "success", dedupKey: clean(reply.dedup_key) };
}

export async function pagerdutyEvent(
  a: { routingKey: string; action: "trigger" | "acknowledge" | "resolve"; dedupKey: string; summary?: string; severity: string; source: string; timeoutMs: number },
  f: Fetch = fetch as unknown as Fetch,
) {
  return enqueue(
    f,
    "/v2/enqueue",
    {
      routing_key: a.routingKey,
      event_action: a.action,
      dedup_key: a.dedupKey,
      ...(a.action === "trigger" ? { payload: { summary: a.summary ?? "MOSS incident", source: a.source, severity: a.severity }, client: "MOSS" } : {}),
    },
    a.timeoutMs,
  );
}

export async function pagerdutyChange(a: { routingKey: string; summary: string; timeoutMs: number }, f: Fetch = fetch as unknown as Fetch) {
  return enqueue(f, "/v2/change/enqueue", { routing_key: a.routingKey, payload: { summary: a.summary, source: "MOSS" } }, a.timeoutMs);
}

/** Incidents from the last day, with their dedup key (MOSS's incident id) and who last acknowledged or resolved them. */
export async function pagerdutyIncidents(a: { apiKey: string; timeoutMs: number }, f: Fetch = fetch as unknown as Fetch, now = new Date()) {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const url = `https://api.pagerduty.com/incidents?since=${encodeURIComponent(since)}&limit=100&statuses[]=triggered&statuses[]=acknowledged&statuses[]=resolved`;
  const res = await f(url, { headers: { Authorization: `Token token=${a.apiKey}`, Accept: "application/vnd.pagerduty+json;version=2" }, signal: AbortSignal.timeout(a.timeoutMs) });
  if (res.status === 401 || res.status === 403) throw new PagerDutyError("PagerDuty rejected the REST API key");
  if (res.status !== 200) throw new PagerDutyError(`PagerDuty answered HTTP ${res.status}`);
  return {
    incidents: arr(obj(await res.json()).incidents).map((i) => {
      const acks = arr(i.acknowledgements);
      const lastAck = acks.at(-1);
      return {
        id: clean(i.id),
        key: clean(i.incident_key),
        status: clean(i.status),
        by: clean(i.status) === "acknowledged" ? (clean(obj(lastAck?.acknowledger).summary) ?? clean(obj(i.last_status_change_by).summary)) : clean(obj(i.last_status_change_by).summary),
        at: clean(i.last_status_change_at),
        url: clean(i.html_url),
      };
    }),
  };
}
