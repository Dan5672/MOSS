import type { DashboardWidget } from "@moss/db";

export const WIDGET_LABELS: Record<DashboardWidget["type"], string> = {
  graph: "Graph",
  gauge: "Gauge",
  value: "Value",
  history: "Up/down history",
  status: "Status grid",
  top: "Top list",
  incidents: "Open incidents",
  note: "Note",
};
