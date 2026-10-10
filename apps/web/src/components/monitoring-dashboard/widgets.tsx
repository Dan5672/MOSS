// Monitoring dashboard widgets that need no browser state: values with sparklines, gauges, up/down history,
// the status grid, top lists and incidents. Plain SVG and HTML, so they render on the server (and in TV mode).
import { formatMetric } from "@moss/core/metrics";
import Link from "next/link";
import { PriorityBadge } from "@/components/badges";
import { cn } from "@/lib/utils";

export interface Point {
  t: number;
  avg: number;
  min: number;
  max: number;
}
export interface Brief {
  id: string;
  name: string;
  kind: string;
  state: string;
  unit?: string;
}

const STATE_FILL: Record<string, string> = {
  up: "bg-phosphor",
  degraded: "bg-amber",
  down: "bg-alarm",
  pending: "bg-dim",
  paused: "bg-muted",
};
const STATE_TEXT: Record<string, string> = { up: "text-phosphor", degraded: "text-amber", down: "text-alarm" };

/** Whichever unit goes with a metric's name (named values carry it in the name). */
export function unitFor(metric: string | undefined, fallback?: string) {
  if (!metric || metric === "value") return fallback ?? "";
  if (metric === "latency") return "ms";
  if (metric === "up") return "";
  if (metric.endsWith("Bps")) return "bps";
  if (metric.endsWith("Percent")) return "%";
  return fallback ?? "";
}

export function showValue(value: number | null | undefined, metric: string | undefined, unit?: string) {
  if (metric === "up") return value === null || value === undefined ? "no value" : value >= 1 ? "up" : "down";
  return formatMetric(value, unitFor(metric, unit));
}

/** A line of the recent values, scaled to fit. */
export function Sparkline({ points, className }: { points: Point[]; className?: string }) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.avg);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * 100;
  const sy = (y: number) => 28 - ((y - y0) / (y1 - y0 || 1)) * 26;
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(2)},${sy(p.avg).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-10 w-full text-phosphor", className)} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A big number for one monitor's metric, with its trend. */
export function ValueWidget({ monitor, value, points, metric, unit }: { monitor: Brief | null; value: number | null; points: Point[]; metric?: string; unit?: string }) {
  if (!monitor) return <Hint>Choose a monitor.</Hint>;
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className={cn("text-4xl font-semibold tabular-nums", STATE_TEXT[monitor.state])}>{showValue(value, metric, unit ?? monitor.unit)}</div>
      <Sparkline points={points} />
    </div>
  );
}

/** A dial from min to max, coloured by the warning and critical levels. */
export function GaugeWidget({
  monitor,
  value,
  min = 0,
  max = 100,
  warn,
  crit,
  metric,
  unit,
}: {
  monitor: Brief | null;
  value: number | null;
  min?: number;
  max?: number;
  warn?: number;
  crit?: number;
  metric?: string;
  unit?: string;
}) {
  if (!monitor) return <Hint>Choose a monitor.</Hint>;
  const frac = value === null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  // An arc from 180° (left) to 0° (right), radius 40, centre (50, 50).
  const arc = (f: number) => {
    const a = Math.PI * (1 - f);
    return [50 + 40 * Math.cos(a), 50 - 40 * Math.sin(a)] as const;
  };
  const [ex, ey] = arc(frac);
  const level = value === null ? "text-dim" : crit !== undefined && value >= crit ? "text-alarm" : warn !== undefined && value >= warn ? "text-amber" : "text-phosphor";
  const tick = (v: number | undefined) => {
    if (v === undefined) return null;
    const [x, y] = arc(Math.min(1, Math.max(0, (v - min) / (max - min || 1))));
    return <circle cx={x} cy={y} r="2" className="fill-current text-ink dark:text-beige" />;
  };
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <svg viewBox="0 0 100 58" className="w-full max-w-56" role="img" aria-label={`${monitor.name}: ${showValue(value, metric, unit)}`}>
        <path d="M10,50 A40,40 0 0 1 90,50" fill="none" strokeWidth="8" className="stroke-muted" />
        {value !== null && frac > 0 && <path d={`M10,50 A40,40 0 0 1 ${ex.toFixed(2)},${ey.toFixed(2)}`} fill="none" strokeWidth="8" stroke="currentColor" className={level} />}
        {tick(warn)}
        {tick(crit)}
      </svg>
      <div className={cn("-mt-4 text-2xl font-semibold tabular-nums", level)}>{showValue(value, metric, unit ?? monitor.unit)}</div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {showValue(min, metric, unit ?? monitor.unit)} – {showValue(max, metric, unit ?? monitor.unit)}
      </div>
    </div>
  );
}

/** One bar per slot of the range: green all up, amber partly, red all down, grey no checks. */
export function HistoryWidget({ rows }: { rows: { monitor: Brief; slots: (number | null)[]; uptime: number | null }[] }) {
  if (!rows.length) return <Hint>No monitors to show.</Hint>;
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.monitor.id} className="grid grid-cols-[minmax(6rem,10rem)_1fr_3.5rem] items-center gap-3 text-sm">
          <Link href={`/monitoring/${r.monitor.id}`} className="truncate hover:underline" title={r.monitor.name}>
            {r.monitor.name}
          </Link>
          <div className="flex h-5 gap-px" role="img" aria-label={`${r.monitor.name} availability`}>
            {r.slots.map((s, i) => (
              <span key={i} className={cn("flex-1", s === null ? "bg-muted" : s >= 0.999 ? "bg-phosphor" : s <= 0.001 ? "bg-alarm" : "bg-amber")} />
            ))}
          </div>
          <span className="text-right font-mono text-xs tabular-nums">{r.uptime === null ? "—" : `${(Math.floor(r.uptime * 1000) / 10).toFixed(1)}%`}</span>
        </li>
      ))}
    </ul>
  );
}

/** Every monitor as a coloured tile, problems first (the at-a-glance view). */
export function StatusWidget({ monitors }: { monitors: Brief[] }) {
  if (!monitors.length) return <Hint>No monitors yet.</Hint>;
  const rank: Record<string, number> = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
  const sorted = [...monitors].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || a.name.localeCompare(b.name));
  const counts = sorted.reduce<Record<string, number>>((c, m) => ((c[m.state] = (c[m.state] ?? 0) + 1), c), {});
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {["down", "degraded", "up"].map((s) => `${counts[s] ?? 0} ${s}`).join(" · ")}
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-1.5">
        {sorted.map((m) => (
          <li key={m.id}>
            <Link
              href={`/monitoring/${m.id}`}
              className={cn("flex min-h-11 items-center px-2 py-1.5 text-sm font-medium text-on-brand", STATE_FILL[m.state] ?? "bg-dim", m.state === "paused" && "text-foreground")}
              title={`${m.name}: ${m.state}`}
            >
              <span className="truncate">{m.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TopWidget({ rows, metric, unit }: { rows: { monitor: Brief; value: number }[]; metric?: string; unit?: string }) {
  if (!rows.length) return <Hint>No values yet.</Hint>;
  const top = Math.max(...rows.map((r) => Math.abs(r.value))) || 1;
  return (
    <ol className="grid gap-1.5 text-sm">
      {rows.map((r) => (
        <li key={r.monitor.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
          <Link href={`/monitoring/${r.monitor.id}`} className="truncate hover:underline">
            {r.monitor.name}
          </Link>
          <span className="font-mono text-xs tabular-nums">{showValue(r.value, metric, unit ?? r.monitor.unit)}</span>
          <span className="col-span-2 h-1 bg-muted">
            <span className="block h-full bg-signal" style={{ width: `${(Math.abs(r.value) / top) * 100}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

export function IncidentsWidget({ incidents }: { incidents: { id: string; number: number; title: string; priority: string; status: string }[] }) {
  if (!incidents.length) return <Hint>No open incidents.</Hint>;
  return (
    <ul className="grid gap-1.5 text-sm">
      {incidents.map((i) => (
        <li key={i.id} className="flex items-center gap-2">
          <PriorityBadge priority={i.priority} />
          <Link href={`/incidents/${i.id}`} className="min-w-0 flex-1 truncate hover:underline" title={i.title}>
            {i.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">{children}</p>;
}
