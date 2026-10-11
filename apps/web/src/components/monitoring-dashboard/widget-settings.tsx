"use client";

import type { DashboardWidget } from "@moss/db";
import { useState } from "react";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WIDGET_LABELS } from "./labels";

export interface MonitorOption {
  id: string;
  name: string;
  kind: string;
  /** Named values its last check recorded (inBps, load1...). */
  metrics: string[];
}

const RANGES = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "1y", label: "Last year" },
];
const BASE_METRICS = [
  { value: "latency", label: "Response time (ms)" },
  { value: "up", label: "Availability" },
  { value: "value", label: "Main value (metric monitors)" },
];

const num = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? undefined : Number(v));
const text = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? undefined : String(v).trim());

/** A widget's settings: which monitors, which value, what range, and its type's own options. */
export function WidgetSettings({
  widget,
  monitors,
  onSave,
  onClose,
}: {
  widget: DashboardWidget;
  monitors: MonitorOption[];
  onSave: (w: DashboardWidget) => void;
  onClose: () => void;
}) {
  const t = widget.type;
  const many = t === "graph" || t === "history" || t === "status" || t === "top";
  const one = t === "value" || t === "gauge";
  const hasMetric = t === "graph" || t === "value" || t === "gauge" || t === "top";
  const [selected, setSelected] = useState<string[]>(widget.monitorIds ?? []);
  const named = [...new Set(monitors.filter((m) => !selected.length || selected.includes(m.id)).flatMap((m) => m.metrics))].sort();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{WIDGET_LABELS[t]} settings</DialogTitle>
          <DialogDescription>
            {many && t !== "graph" ? "Leave every monitor unticked to include them all." : "Changes show once the dashboard is saved."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ids = one ? [String(f.get("monitor") ?? "")].filter(Boolean) : selected;
            const metric = text(f.get("metricName")) ?? text(f.get("metric"));
            onSave({
              id: widget.id,
              type: t,
              w: widget.w,
              h: widget.h,
              title: text(f.get("title")),
              ...(many || one ? { monitorIds: ids } : {}),
              ...(hasMetric && metric ? { metric } : {}),
              ...(f.get("range") ? { range: String(f.get("range")) as DashboardWidget["range"] } : {}),
              ...(t === "gauge" ? { min: num(f.get("min")), max: num(f.get("max")), warn: num(f.get("warn")), crit: num(f.get("crit")) } : {}),
              ...(one || t === "graph" || t === "top" ? { unit: text(f.get("unit")) } : {}),
              ...(t === "top" || t === "incidents" ? { count: num(f.get("count")) } : {}),
              ...(t === "top" ? { order: f.get("order") === "asc" ? "asc" : "desc" } : {}),
              ...(t === "note" ? { text: String(f.get("text") ?? "") } : {}),
            });
          }}
        >
          <TextField label="Title (optional)" name="title" defaultValue={widget.title} maxLength={80} />
          {one && (
            <SelectField
              label="Monitor"
              name="monitor"
              defaultValue={widget.monitorIds?.[0] ?? ""}
              onChange={(e) => setSelected(e.target.value ? [e.target.value] : [])}
              options={[{ value: "", label: "Choose a monitor" }, ...monitors.map((m) => ({ value: m.id, label: m.name }))]}
              required
            />
          )}
          {many && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Monitors</legend>
              <div className="grid max-h-48 gap-1 overflow-y-auto border-2 p-2 sm:grid-cols-2">
                {monitors.map((m) => (
                  <CheckboxField
                    key={m.id}
                    label={m.name}
                    checked={selected.includes(m.id)}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, m.id] : selected.filter((id) => id !== m.id))}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {hasMetric && (
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Show"
                name="metric"
                defaultValue={BASE_METRICS.some((b) => b.value === widget.metric) ? widget.metric : "latency"}
                options={BASE_METRICS}
              />
              <TextField
                label="Or a named value"
                name="metricName"
                defaultValue={widget.metric && !BASE_METRICS.some((b) => b.value === widget.metric) ? widget.metric : undefined}
                list="moss-metric-names"
                placeholder={named[0] ?? "inBps"}
                hint="From metric monitors, such as inBps or diskUsedPercent."
              />
              <datalist id="moss-metric-names">
                {named.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
          )}
          {(t === "graph" || t === "value" || t === "history") && <SelectField label="Range" name="range" defaultValue={widget.range ?? "24h"} options={RANGES} />}
          {t === "gauge" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Lowest" name="min" type="number" step="any" defaultValue={widget.min ?? 0} />
              <TextField label="Highest" name="max" type="number" step="any" defaultValue={widget.max ?? 100} />
              <TextField label="Amber from" name="warn" type="number" step="any" defaultValue={widget.warn} />
              <TextField label="Red from" name="crit" type="number" step="any" defaultValue={widget.crit} />
            </div>
          )}
          {(one || t === "graph" || t === "top") && <TextField label="Unit (optional)" name="unit" defaultValue={widget.unit} placeholder="%" />}
          {(t === "top" || t === "incidents") && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="How many" name="count" type="number" min={1} max={25} defaultValue={widget.count ?? (t === "top" ? 5 : 8)} />
              {t === "top" && (
                <SelectField
                  label="Order"
                  name="order"
                  defaultValue={widget.order ?? "desc"}
                  options={[
                    { value: "desc", label: "Highest first" },
                    { value: "asc", label: "Lowest first" },
                  ]}
                />
              )}
            </div>
          )}
          {t === "note" && <TextAreaField label="Note (Markdown)" name="text" rows={6} defaultValue={widget.text} maxLength={4000} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
