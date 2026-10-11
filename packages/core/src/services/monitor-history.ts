// Monitor history for graphs: rolls raw check results up into 5-minute buckets, and those into hourly ones,
// prunes each by age, and answers "this metric for these monitors over this range" from whichever level of
// detail suits the range.
import { monitorResults, monitorRollups, monitors, type Database } from "@moss/db";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

/** How long each level is kept. Raw results follow the monitoring.retention_days setting. */
export const ROLLUP_RETENTION_DAYS = { "5m": 90, "1h": 730 } as const;

const EPOCH = "2000-01-01T00:00:00Z";

/**
 * Builds 5-minute rollups from raw results, then hourly ones from those. Only finished buckets, starting a
 * little before the newest one already built, so it catches up after a pause and is safe to run again.
 */
export async function rollUpMonitorResults(db: Database, now = new Date()): Promise<{ fiveMinute: number; hourly: number }> {
  const fiveMinute = await db.execute(sql`
    with bounds as (
      select coalesce((select max(bucket) - interval '10 minutes' from monitor_rollups where resolution = '5m'), '-infinity'::timestamptz) as "from",
             date_bin('5 minutes', ${now.toISOString()}::timestamptz, ${EPOCH}::timestamptz) as "to"
    ),
    r as (
      select res.monitor_id, date_bin('5 minutes', res.at, ${EPOCH}::timestamptz) as b, res.ok, res.degraded, res.latency_ms,
             coalesce(res."values", '{}'::jsonb) || case when res."value" is not null then jsonb_build_object('value', res."value") else '{}'::jsonb end as v
      from monitor_results res, bounds
      where res.at >= bounds."from" and res.at < bounds."to"
    ),
    base as (
      select monitor_id, b, count(*)::int as checks, (count(*) filter (where ok))::int as ok, (count(*) filter (where degraded))::int as degraded,
             min(latency_ms)::float8 as lmin, avg(latency_ms)::float8 as lavg, max(latency_ms)::float8 as lmax
      from r group by monitor_id, b
    ),
    m as (
      select r.monitor_id, r.b, e.key, min(e.value::float8) as mn, avg(e.value::float8) as av, max(e.value::float8) as mx
      from r, jsonb_each_text(r.v) e
      where e.value ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
      group by r.monitor_id, r.b, e.key
    ),
    ma as (
      select monitor_id, b, jsonb_object_agg(key, jsonb_build_object('min', mn, 'avg', av, 'max', mx)) as metrics
      from m group by monitor_id, b
    )
    insert into monitor_rollups (monitor_id, resolution, bucket, checks, ok, degraded, latency_min, latency_avg, latency_max, metrics)
    select base.monitor_id, '5m', base.b, base.checks, base.ok, base.degraded, base.lmin, base.lavg, base.lmax, coalesce(ma.metrics, '{}'::jsonb)
    from base left join ma on ma.monitor_id = base.monitor_id and ma.b = base.b
    on conflict (monitor_id, resolution, bucket) do update set
      checks = excluded.checks, ok = excluded.ok, degraded = excluded.degraded,
      latency_min = excluded.latency_min, latency_avg = excluded.latency_avg, latency_max = excluded.latency_max, metrics = excluded.metrics
  `);

  // Hours from the 5-minute rollups, averages weighted by the number of checks.
  const hourly = await db.execute(sql`
    with bounds as (
      select coalesce((select max(bucket) - interval '1 hour' from monitor_rollups where resolution = '1h'), '-infinity'::timestamptz) as "from",
             date_bin('1 hour', ${now.toISOString()}::timestamptz, ${EPOCH}::timestamptz) as "to"
    ),
    r as (
      select f.*, date_bin('1 hour', f.bucket, ${EPOCH}::timestamptz) as b
      from monitor_rollups f, bounds
      where f.resolution = '5m' and f.bucket >= bounds."from" and f.bucket < bounds."to"
    ),
    base as (
      select monitor_id, b, sum(checks)::int as checks, sum(ok)::int as ok, sum(degraded)::int as degraded,
             min(latency_min) as lmin,
             sum(latency_avg * checks) / nullif(sum(case when latency_avg is not null then checks end), 0) as lavg,
             max(latency_max) as lmax
      from r group by monitor_id, b
    ),
    m as (
      select r.monitor_id, r.b, e.key, min((e.value->>'min')::float8) as mn, sum((e.value->>'avg')::float8 * r.checks) / sum(r.checks) as av,
             max((e.value->>'max')::float8) as mx
      from r, jsonb_each(r.metrics) e
      group by r.monitor_id, r.b, e.key
    ),
    ma as (
      select monitor_id, b, jsonb_object_agg(key, jsonb_build_object('min', mn, 'avg', av, 'max', mx)) as metrics
      from m group by monitor_id, b
    )
    insert into monitor_rollups (monitor_id, resolution, bucket, checks, ok, degraded, latency_min, latency_avg, latency_max, metrics)
    select base.monitor_id, '1h', base.b, base.checks, base.ok, base.degraded, base.lmin, base.lavg, base.lmax, coalesce(ma.metrics, '{}'::jsonb)
    from base left join ma on ma.monitor_id = base.monitor_id and ma.b = base.b
    on conflict (monitor_id, resolution, bucket) do update set
      checks = excluded.checks, ok = excluded.ok, degraded = excluded.degraded,
      latency_min = excluded.latency_min, latency_avg = excluded.latency_avg, latency_max = excluded.latency_max, metrics = excluded.metrics
  `);
  return { fiveMinute: fiveMinute.count ?? 0, hourly: hourly.count ?? 0 };
}

/** Drops rollups older than they're kept. */
export async function pruneMonitorRollups(db: Database, now = new Date()): Promise<number> {
  let total = 0;
  for (const [resolution, days] of Object.entries(ROLLUP_RETENTION_DAYS)) {
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const res = await db.delete(monitorRollups).where(and(eq(monitorRollups.resolution, resolution as "5m" | "1h"), lt(monitorRollups.bucket, cutoff)));
    total += res.count ?? 0;
  }
  return total;
}

/** "latency" (ms), "up" (share of good checks, 0-1), "value" (the main value), or a named value such as inBps. */
export type SeriesMetric = string;
export interface SeriesPoint {
  t: number;
  avg: number;
  min: number;
  max: number;
}
export type SeriesResolution = "raw" | "5m" | "1h";

/** The level of detail for a range: raw up to a day and a half, 5-minute buckets up to a month, then hourly. */
export function resolutionFor(from: Date, to: Date): SeriesResolution {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  return hours <= 36 ? "raw" : hours <= 31 * 24 ? "5m" : "1h";
}

/** One metric for some monitors (only the org's own) over a range, from raw results or rollups. */
export async function monitorSeries(
  db: Database,
  orgId: string,
  monitorIds: string[],
  metric: SeriesMetric,
  from: Date,
  to: Date,
  resolution: SeriesResolution = resolutionFor(from, to),
): Promise<{ resolution: SeriesResolution; series: Record<string, SeriesPoint[]> }> {
  const owned = monitorIds.length
    ? (await db.select({ id: monitors.id }).from(monitors).where(and(eq(monitors.orgId, orgId), inArray(monitors.id, monitorIds)))).map((m) => m.id)
    : [];
  const series: Record<string, SeriesPoint[]> = Object.fromEntries(owned.map((id) => [id, []]));
  if (!owned.length) return { resolution, series };

  if (resolution === "raw") {
    const rows = await db
      .select({ monitorId: monitorResults.monitorId, at: monitorResults.at, ok: monitorResults.ok, latencyMs: monitorResults.latencyMs, value: monitorResults.value, values: monitorResults.values })
      .from(monitorResults)
      .where(and(inArray(monitorResults.monitorId, owned), gte(monitorResults.at, from), lt(monitorResults.at, to)))
      .orderBy(asc(monitorResults.at))
      .limit(20_000);
    for (const r of rows) {
      const v = metric === "latency" ? r.latencyMs : metric === "up" ? (r.ok ? 1 : 0) : metric === "value" ? r.value : (r.values?.[metric] ?? null);
      if (v === null || v === undefined) continue;
      series[r.monitorId]!.push({ t: r.at.getTime(), avg: v, min: v, max: v });
    }
    return { resolution, series };
  }

  const rows = await db
    .select()
    .from(monitorRollups)
    .where(and(inArray(monitorRollups.monitorId, owned), eq(monitorRollups.resolution, resolution), gte(monitorRollups.bucket, from), lt(monitorRollups.bucket, to)))
    .orderBy(asc(monitorRollups.bucket))
    .limit(20_000);
  for (const r of rows) {
    let p: Omit<SeriesPoint, "t"> | null = null;
    if (metric === "latency") p = r.latencyAvg === null ? null : { avg: r.latencyAvg, min: r.latencyMin ?? r.latencyAvg, max: r.latencyMax ?? r.latencyAvg };
    else if (metric === "up") {
      const share = r.checks ? r.ok / r.checks : 0;
      p = { avg: share, min: share, max: share };
    } else p = r.metrics[metric] ?? null;
    if (p) series[r.monitorId]!.push({ t: r.bucket.getTime(), ...p });
  }
  return { resolution, series };
}

/** Share of good checks per monitor over a range (null when there were none), from the same levels as graphs. */
export async function monitorUptime(db: Database, orgId: string, monitorIds: string[], from: Date, to: Date): Promise<Record<string, number | null>> {
  const { series } = await monitorSeries(db, orgId, monitorIds, "up", from, to, resolutionFor(from, to) === "raw" ? "raw" : "5m");
  return Object.fromEntries(Object.entries(series).map(([id, pts]) => [id, pts.length ? pts.reduce((a, p) => a + p.avg, 0) / pts.length : null]));
}
