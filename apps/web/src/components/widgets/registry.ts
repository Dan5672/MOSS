// The cards a dashboard can show. Shared by the main dashboard (and, later, monitoring dashboards): each
// card has an id, a name for the "Add a card" menu, and a default size. A layout is just an ordered list
// of { id, size }, saved per person.

export type WidgetSize = "s" | "m" | "l";
export interface WidgetLayoutItem {
  id: string;
  size: WidgetSize;
}
export interface WidgetInfo {
  id: string;
  title: string;
  description: string;
  size: WidgetSize;
}

export const DASHBOARD_WIDGETS: WidgetInfo[] = [
  { id: "briefing", title: "Briefing", description: "What needs you, in a sentence.", size: "l" },
  { id: "stat-incidents", title: "Open incidents", description: "How many, by priority.", size: "s" },
  { id: "stat-monitors", title: "Monitors down", description: "Down, degraded and up.", size: "s" },
  { id: "stat-approvals", title: "Awaiting approval", description: "Changes waiting for you.", size: "s" },
  { id: "stat-assets", title: "Assets", description: "Devices, and how many are new this week.", size: "s" },
  { id: "stat-agents", title: "Agents", description: "Active and paused.", size: "s" },
  { id: "stat-spend", title: "Spend this month", description: "Cost so far, against the monthly cap.", size: "s" },
  { id: "token-spend", title: "Token spend", description: "Tokens and cost: today, this month, 30 days, by agent and model.", size: "m" },
  { id: "team", title: "The team", description: "Each agent, what it last did, and its budget.", size: "m" },
  { id: "incident-queue", title: "Incident queue", description: "Open incidents, oldest first.", size: "m" },
  { id: "audit-tail", title: "Audit tail", description: "The latest actions, as they happen.", size: "m" },
];

export const DEFAULT_DASHBOARD: WidgetLayoutItem[] = DASHBOARD_WIDGETS.map((w) => ({ id: w.id, size: w.size }));

/** A saved layout, cleaned up: unknown cards dropped, sizes checked. Falls back to the default. */
export function readLayout(saved: unknown, known: WidgetInfo[] = DASHBOARD_WIDGETS, fallback = DEFAULT_DASHBOARD): WidgetLayoutItem[] {
  if (!Array.isArray(saved)) return fallback;
  const ids = new Set(known.map((w) => w.id));
  const seen = new Set<string>();
  const out: WidgetLayoutItem[] = [];
  for (const item of saved) {
    const id = (item as WidgetLayoutItem)?.id;
    const size = (item as WidgetLayoutItem)?.size;
    if (typeof id !== "string" || !ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, size: size === "s" || size === "m" || size === "l" ? size : known.find((w) => w.id === id)!.size });
  }
  return out;
}

/** Grid classes for a card's size: 2 columns on phones, 4 on tablets, 6 on desktops. */
export const SIZE_CLASS: Record<WidgetSize, string> = {
  s: "col-span-1",
  m: "col-span-2 lg:col-span-3",
  l: "col-span-2 md:col-span-4 lg:col-span-6",
};
