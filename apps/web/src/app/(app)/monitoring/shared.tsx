import "server-only";
import { assets } from "@moss/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { cn } from "@/lib/utils";
import { db } from "@/server/db";
import { assigneeOptions } from "@/server/people";

export async function monitorFormOptions(orgId: string) {
  const [assetRows, people] = await Promise.all([
    db()
      .select({ id: assets.id, name: assets.name, ip: assets.primaryIp })
      .from(assets)
      .where(and(eq(assets.orgId, orgId), ne(assets.status, "retired")))
      .orderBy(asc(assets.name))
      .limit(500),
    assigneeOptions(orgId),
  ]);
  return {
    assets: assetRows.map((a) => ({ value: a.id, label: a.ip ? `${a.name} (${a.ip})` : a.name })),
    responders: people.map((p) => (p.value === "" ? { ...p, label: "Nobody (incident is unassigned)" } : p)),
  };
}

export function formatUptime(u: number | null | undefined): string {
  if (u === null || u === undefined) return "—";
  return `${(Math.floor(u * 1000) / 10).toFixed(u === 1 ? 0 : 1)}%`;
}

export function describeTarget(m: { kind: string; target: string; config: { port?: number; scheme?: string; path?: string; recordType?: string } }): string {
  const c = m.config;
  switch (m.kind) {
    case "http":
      return `${c.scheme ?? "http"}://${m.target}${c.port ? `:${c.port}` : ""}${c.path ?? "/"}`;
    case "tcp":
    case "tls":
      return `${m.target}:${c.port ?? 443}`;
    case "dns":
      return `${m.target} ${c.recordType ?? "A"}`;
    default:
      return m.target || "—";
  }
}

type Result = { at: Date; ok: boolean; degraded: boolean; latencyMs: number | null; message: string };

/** 24 hours as 48 half-hour bars: red if any check failed, amber if any was degraded, green if all passed. */
export function UptimeStrip({ results, now = new Date() }: { results: Result[]; now?: Date }) {
  const BUCKETS = 48;
  const span = 24 * 3_600_000;
  const start = now.getTime() - span;
  const buckets = Array.from({ length: BUCKETS }, () => ({ n: 0, fail: 0, degraded: 0 }));
  for (const r of results) {
    const i = Math.floor(((r.at.getTime() - start) / span) * BUCKETS);
    if (i < 0 || i >= BUCKETS) continue;
    buckets[i]!.n++;
    if (!r.ok) buckets[i]!.fail++;
    else if (r.degraded) buckets[i]!.degraded++;
  }
  return (
    <div>
      <div className="flex h-8 gap-px" role="img" aria-label="Check results over the last 24 hours">
        {buckets.map((b, i) => {
          const from = new Date(start + (i * span) / BUCKETS);
          const label = b.n === 0 ? "no checks" : b.fail ? `${b.fail} of ${b.n} failed` : b.degraded ? `${b.degraded} of ${b.n} degraded` : `${b.n} passed`;
          return (
            <div
              key={i}
              title={`${from.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${label}`}
              className={cn("flex-1 rounded-sm", b.n === 0 ? "bg-muted" : b.fail ? "bg-red-500" : b.degraded ? "bg-amber-500" : "bg-emerald-500")}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

export function latencyStats(results: Result[]) {
  const values = results.filter((r) => r.ok && r.latencyMs !== null).map((r) => r.latencyMs!);
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { min: values[0]!, avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length), p95: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]! };
}
