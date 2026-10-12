// PagerDuty (business): MOSS pages the on-call person for its incidents and stands the page down when the incident is
// resolved. The Events API with an integration key does the paging (it can only send events to that one service);
// an optional read-only REST API key lets MOSS see who acknowledged or resolved a page, noted on the MOSS incident.
import { integrationOption, type FeatureOutput, type IntegrationConfig, type IntegrationDef } from "./types.js";

export const PAGERDUTY_API_SECRET = "pagerduty-api-key";

const SEVERITY = { P1: "critical", P2: "error", P3: "warning", P4: "info" } as const;

export interface PdIncident {
  id?: string;
  key?: string;
  status?: string;
  /** Who last acknowledged or resolved it. */
  by?: string;
  at?: string;
  url?: string;
}

/** Whether an incident at this priority pages someone (P1 up to the configured level). */
export function pagerdutyPages(c: IntegrationConfig, priority: string): boolean {
  return Number(priority.slice(1)) <= integrationOption(PAGERDUTY, c, "pageUpTo");
}

/** The event for a MOSS incident: triggered (or resolved), keyed by its id so the two match up. */
export function pagerdutyEventArgs(inc: { id: string; number: number; title: string; priority: string }, action: "trigger" | "resolve") {
  return {
    action,
    dedupKey: inc.id,
    summary: `INC-${String(inc.number).padStart(4, "0")} ${inc.title}`.slice(0, 1024),
    severity: SEVERITY[inc.priority as keyof typeof SEVERITY] ?? "error",
    source: "MOSS",
  };
}

export function pagerdutyAcks(r: { incidents: PdIncident[] }, now: Date): FeatureOutput {
  const acked = r.incidents.filter((i) => i.status === "acknowledged").length;
  return { summary: `${r.incidents.length} recent page(s), ${acked} acknowledged`, state: { pagerduty: { at: now.toISOString(), incidents: r.incidents } } };
}

export const PAGERDUTY: IntegrationDef = {
  key: "pagerduty",
  name: "PagerDuty",
  description: "Page the on-call person for MOSS's serious incidents, stand the page down when they're resolved, and see who acknowledged it.",
  plan: "business",
  connection: {
    defaultPort: 443,
    cloud: true,
    hint: "In PagerDuty, open the service that should be paged, Integrations > Add an integration > Events API V2, and copy its integration key.",
  },
  credential: {
    secretName: "pagerduty-routing-key",
    type: "api_token",
    arg: "routingKey",
    label: "Integration key",
    hint: "The Events API V2 integration key (32 characters). It can only send events to that one service.",
    tools: ["pagerduty_event", "pagerduty_change"],
  },
  test: {
    op: "test",
    describe: () => "Connected: PagerDuty took a change event (it shows on the service's timeline, and pages nobody).",
  },
  ops: {
    test: { tool: "pagerduty_change", args: () => ({ summary: "MOSS connected to this service" }) },
    event: { tool: "pagerduty_event", callerArgs: ["incidentId", "action"], fromIncident: (inc, a) => pagerdutyEventArgs(inc, a.action === "resolve" ? "resolve" : "trigger") },
    incidents: { tool: "pagerduty_incidents", secret: { name: PAGERDUTY_API_SECRET, arg: "apiKey", label: "the REST API key" } },
  },
  features: [
    {
      key: "acks",
      label: "Acknowledgements in MOSS",
      description: "Every 2 minutes: who acknowledged or resolved each page, noted on the MOSS incident. Needs a read-only REST API key (below).",
      everyMs: 2 * 60_000,
      op: "incidents",
      apply: (r, { now }) => pagerdutyAcks(r as { incidents: PdIncident[] }, now),
    },
  ],
  options: [{ key: "pageUpTo", label: "Page for incidents from P1 up to (1-4)", hint: "2 pages for P1 and P2 incidents.", default: 2, min: 1, max: 4 }],
  agentTools: [],
};
