// A dashboard's widgets as cards, from the data gathered on the server. Shared by the dashboard page, its
// editor and TV mode.
import type { WidgetData } from "@moss/core";
import type { DashboardWidget } from "@moss/db";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TimeSeriesChart } from "./time-series-chart";
import { GaugeWidget, HistoryWidget, Hint, IncidentsWidget, StatusWidget, TopWidget, unitFor, ValueWidget } from "./widgets";
import { WIDGET_LABELS } from "./labels";
import { NoteText } from "./note-text";


const METRIC_LABELS: Record<string, string> = { latency: "response time", up: "availability", value: "value" };

/** A title for a widget that has none: its type, and its metric. */
export function widgetTitle(w: DashboardWidget, monitorName?: string) {
  if (w.title) return w.title;
  if (w.type === "value" || w.type === "gauge") return monitorName ?? WIDGET_LABELS[w.type];
  if (w.type === "graph" || w.type === "top") return `${WIDGET_LABELS[w.type]}: ${METRIC_LABELS[w.metric ?? "latency"] ?? w.metric}`;
  return WIDGET_LABELS[w.type];
}

/** The size of a widget on the 12-column grid (full width on phones). */
export function widgetStyle(w: Pick<DashboardWidget, "w" | "h">): CSSProperties {
  return { "--w": w.w, gridRow: `span ${w.h} / span ${w.h}` } as CSSProperties;
}
export const GRID_CLASS = "grid grid-cols-1 auto-rows-[160px] gap-3 md:grid-cols-12";
export const CELL_CLASS = "min-w-0 md:[grid-column:span_var(--w)/span_var(--w)]";

function body(w: DashboardWidget, d: WidgetData | undefined): ReactNode {
  if (!d) return <Hint>Save to see it.</Hint>;
  switch (d.type) {
    case "graph":
      return (
        <TimeSeriesChart
          series={d.series.map((s) => ({ name: s.monitor.name, points: s.points }))}
          unit={w.metric === "up" ? "up" : unitFor(w.metric ?? "latency", w.unit ?? d.series[0]?.monitor.unit)}
          from={d.from}
          to={d.to}
        />
      );
    case "value":
      return <ValueWidget monitor={d.monitor} value={d.value} points={d.points} metric={w.metric} unit={w.unit} />;
    case "gauge":
      return <GaugeWidget monitor={d.monitor} value={d.value} min={w.min} max={w.max} warn={w.warn} crit={w.crit} metric={w.metric} unit={w.unit} />;
    case "history":
      return <HistoryWidget rows={d.rows} />;
    case "status":
      return <StatusWidget monitors={d.monitors} />;
    case "top":
      return <TopWidget rows={d.rows} metric={w.metric ?? "latency"} unit={w.unit} />;
    case "incidents":
      return <IncidentsWidget incidents={d.incidents} />;
    default:
      return w.text ? <NoteText text={w.text} /> : <Hint>An empty note.</Hint>;
  }
}

/** One widget's card: a title bar and its content, scrolling inside if it's taller than the space. */
export function WidgetCard({ widget, data, className }: { widget: DashboardWidget; data?: WidgetData; className?: string }) {
  const monitorName = data && (data.type === "value" || data.type === "gauge") ? data.monitor?.name : undefined;
  return (
    <section aria-label={widgetTitle(widget, monitorName)} className={cn("flex h-full min-h-0 flex-col border-2 bg-card", className)}>
      <h3 className="truncate border-b-2 px-3 py-1.5 text-sm font-medium" title={widgetTitle(widget, monitorName)}>
        {widgetTitle(widget, monitorName)}
        {widget.range && widget.type !== "status" && widget.type !== "incidents" && widget.type !== "note" && (
          <span className="ml-2 font-mono text-xs text-muted-foreground">{widget.range}</span>
        )}
      </h3>
      <div className="min-h-0 flex-1 overflow-auto p-3">{body(widget, data)}</div>
    </section>
  );
}

/** Each widget's card by id, for the grid and the editor. */
export function widgetCards(widgets: DashboardWidget[], data: Record<string, WidgetData>): Record<string, ReactNode> {
  return Object.fromEntries(widgets.map((w) => [w.id, <WidgetCard key={w.id} widget={w} data={data[w.id]} />]));
}

export function DashboardGrid({ widgets, data, className }: { widgets: DashboardWidget[]; data: Record<string, WidgetData>; className?: string }) {
  return (
    <div className={cn(GRID_CLASS, className)}>
      {widgets.map((w) => (
        <div key={w.id} className={CELL_CLASS} style={widgetStyle(w)}>
          <WidgetCard widget={w} data={data[w.id]} />
        </div>
      ))}
    </div>
  );
}
