// What an integration is: how to reach the product, the credential it needs, the features it runs in the
// background, and how each feature's tool result turns into inventory and monitoring. Definitions are data plus
// pure functions, so they're easy to test and the gate, worker and web app can all read them.
import type { ParsedAlert } from "../monitoring/webhooks.js";

/** A device or service an integration knows about, for the inventory. */
export interface InventoryItem {
  /** The product's own id for it (a VM id, a container id, a client id), stable across syncs. */
  externalId: string;
  name?: string;
  /** server, vm, container, iot, workstation... */
  kind?: string;
  vendor?: string;
  model?: string;
  os?: string;
  ips: string[];
  macs: string[];
  /** The externalId of what it runs on (a VM's node, a container's host), in the same sync. */
  parentExternalId?: string;
  /** Added even without an address in an allowed network (VMs and containers the product reports itself). */
  createWithoutIp?: boolean;
  /** Shown on the asset page under the integration's name. */
  details?: Record<string, unknown>;
}

/** What one feature's run produced. */
export interface FeatureOutput {
  inventory?: InventoryItem[];
  alerts?: ParsedAlert[];
  /** A one-line summary for the integration's page. */
  summary?: string;
  /** Kept in the integration's state for other checks to read (the UPS readings, for the shutdown plan). */
  state?: Record<string, unknown>;
}

export interface IntegrationFeature {
  key: string;
  label: string;
  description: string;
  /** How often it runs. */
  everyMs: number;
  /** The gate operation it calls. */
  op: string;
  /** Turns the tool's result into inventory and alerts (or an alert saying it couldn't be reached). */
  apply: (result: unknown, ctx: { config: IntegrationConfig; now: Date }) => FeatureOutput;
}

export interface IntegrationOp {
  tool: string;
  /** Extra arguments for this operation, from the config. */
  args?: (c: IntegrationConfig) => Record<string, unknown>;
}

export interface IntegrationDef {
  key: string;
  name: string;
  /** For the Integrations page. */
  description: string;
  /** Free now; some will be on a paid plan later. */
  plan: "free" | "paid";
  /** How MOSS reaches it (fields shown on its settings page). */
  connection: {
    defaultPort: number;
    /** Offer http/https. */
    scheme?: { default: "http" | "https" };
    /** It's plain HTTP or its own protocol: no certificate to check. */
    tls?: false;
    /** A user name as well as the credential (AdGuard Home). */
    user?: { label: string };
    /**
     * Several hosts instead of one (Docker): each is called in turn, and features get
     * { hosts: [{ host, port, ok, result | error }] }.
     */
    multipleHosts?: { label: string; hint: string };
    hint: string;
  };
  /** The credential, stored as a secret only the gate can read. Absent: the product needs none. */
  credential?: {
    /** It works without one too (a UPS server with no password). */
    optional?: boolean;
    secretName: string;
    type: "api_token" | "password";
    /** The tool argument it goes in. */
    arg: string;
    label: string;
    hint: string;
    /** Every tool it may be used with (the secret's tool scope). */
    tools: string[];
  };
  /** The operation the Test connection button runs, and how to describe what it found. */
  test: { op: string; describe: (result: unknown) => string };
  ops: Record<string, IntegrationOp>;
  features: IntegrationFeature[];
  /** Agent tools that come with it, offered on its page to grant to an agent. */
  agentTools: string[];
  /** Every tool it uses (the credential's tool scope, and how a tool is traced to its integration). */
  tools?: string[];
  /** Numbers people can tune (thresholds), shown with the features. */
  options?: IntegrationOption[];
}

export interface IntegrationOption {
  key: string;
  label: string;
  hint?: string;
  default: number;
  min: number;
  max: number;
}

/** An option's value, or its default. */
export function integrationOption(def: IntegrationDef, c: IntegrationConfig, key: string): number {
  const o = def.options?.find((x) => x.key === key);
  const v = c.options[key];
  return typeof v === "number" && o && v >= o.min && v <= o.max ? v : (o?.default ?? 0);
}

/** The stored config every integration shares. */
export interface IntegrationConfig {
  host?: string;
  port: number;
  /** For integrations with several hosts. */
  hosts: { host: string; port: number }[];
  scheme: "http" | "https";
  verifyTls: boolean;
  user?: string;
  features: Record<string, boolean>;
  /** Incidents from this integration. */
  priority: "P1" | "P2" | "P3" | "P4";
  responderAgentId?: string;
  /** Integration-specific options (thresholds and the like). */
  options: Record<string, unknown>;
}

/** What MOSS records while running it. */
export interface IntegrationState {
  sourceId?: string;
  /** Per feature: when it last ran, and what came of it. */
  runs?: Record<string, { at: string; ok: boolean; summary: string }>;
}
