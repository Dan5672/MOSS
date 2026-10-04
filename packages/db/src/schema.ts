// MOSS database schema. Every table carries org_id/site_id so a single-tenant
// install can later grow into multi-site / MSP deployments without a rewrite.
// Kept in one file so drizzle-kit can load it without cross-file resolution.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  cidr,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const tenancy = () => ({
  orgId: uuid("org_id").notNull(),
  siteId: uuid("site_id"),
});
const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------
export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  ...timestamps(),
});

export const sites = pgTable("sites", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => orgs.id),
  name: text("name").notNull(),
  ...timestamps(),
});

// ---------------------------------------------------------------------------
// Users & access
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: id(),
    ...tenancy(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    totpSecretRef: text("totp_secret_ref"),
    oidcSubject: text("oidc_subject"),
    status: text("status", { enum: ["active", "invited", "disabled"] }).notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("users_org_email_idx").on(t.orgId, t.email)],
);

export const roles = pgTable("roles", {
  id: id(),
  ...tenancy(),
  key: text("key").notNull(), // owner | admin | change_approver | operator | viewer | agent | custom
  name: text("name").notNull(),
  builtIn: boolean("built_in").notNull().default(false),
  ...timestamps(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------
export const providers = pgTable("providers", {
  id: id(),
  ...tenancy(),
  kind: text("kind", { enum: ["anthropic", "openai", "openrouter", "ollama", "openai_compatible"] }).notNull(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  apiKeySecretId: uuid("api_key_secret_id"),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps(),
});

export const models = pgTable(
  "models",
  {
    id: id(),
    ...tenancy(),
    providerId: uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(), // provider's identifier, e.g. claude-sonnet-5-5
    displayName: text("display_name").notNull(),
    // Prices in USD per million tokens; editable by the user.
    inputPricePerMTok: numeric("input_price_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    outputPricePerMTok: numeric("output_price_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    cacheReadPricePerMTok: numeric("cache_read_price_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    cacheWritePricePerMTok: numeric("cache_write_price_per_mtok", { precision: 12, scale: 4 }).notNull().default("0"),
    contextWindow: integer("context_window"),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [uniqueIndex("models_provider_model_idx").on(t.providerId, t.modelId)],
);

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
export const agentStatus = pgEnum("agent_status", ["active", "paused", "fired"]);

export const agents = pgTable("agents", {
  id: id(),
  ...tenancy(),
  name: text("name").notNull(),
  title: text("title").notNull(), // e.g. "Network Admin"
  templateKey: text("template_key"),
  status: agentStatus("status").notNull().default("active"),
  modelId: uuid("model_id").references(() => models.id),
  systemPrompt: text("system_prompt").notNull(),
  reportsToAgentId: uuid("reports_to_agent_id"),
  reportsToUserId: uuid("reports_to_user_id").references(() => users.id),
  roleId: uuid("role_id").references(() => roles.id),
  effort: text("effort", { enum: ["low", "medium", "high", "xhigh", "max"] }).notNull().default("medium"),
  maxStepsPerRun: integer("max_steps_per_run").notNull().default(25),
  pausedReason: text("paused_reason"),
  hiredAt: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  ...timestamps(),
});

export const skills = pgTable(
  "skills",
  {
    id: id(),
    ...tenancy(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    version: text("version").notNull().default("1.0.0"),
    instructions: text("instructions").notNull(), // SKILL.md body
    toolGrants: jsonb("tool_grants").$type<string[]>().notNull().default([]),
    commandTemplates: jsonb("command_templates").$type<Record<string, string>>().notNull().default({}),
    builtIn: boolean("built_in").notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex("skills_org_key_idx").on(t.orgId, t.key)],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const agentSchedules = pgTable("agent_schedules", {
  id: id(),
  ...tenancy(),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  task: text("task").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

export const budgets = pgTable("budgets", {
  id: id(),
  ...tenancy(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }), // null = global
  period: text("period", { enum: ["day", "month"] }).notNull(),
  unit: text("unit", { enum: ["tokens", "usd"] }).notNull(),
  softLimit: numeric("soft_limit", { precision: 16, scale: 4 }),
  hardLimit: numeric("hard_limit", { precision: 16, scale: 4 }).notNull(),
  ...timestamps(),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    ...tenancy(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    trigger: text("trigger", { enum: ["schedule", "event", "ticket", "chat", "manual"] }).notNull(),
    triggerRef: text("trigger_ref"),
    status: text("status", { enum: ["running", "succeeded", "failed", "aborted"] }).notNull().default("running"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_agent_idx").on(t.agentId, t.startedAt)],
);

export const runSteps = pgTable("run_steps", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind", { enum: ["message", "tool_call", "tool_result", "policy_denied", "error"] }).notNull(),
  content: jsonb("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tokenUsage = pgTable(
  "token_usage",
  {
    id: id(),
    ...tenancy(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: uuid("run_id").references(() => agentRuns.id),
    modelId: uuid("model_id").notNull().references(() => models.id),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    /** Model that actually served the call (differs from modelId after a refusal fallback). */
    servedModel: text("served_model"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("token_usage_agent_time_idx").on(t.agentId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Networks & assets
// ---------------------------------------------------------------------------
export const networkStatus = pgEnum("network_status", ["allowed", "off_limits", "unknown"]);

export const networks = pgTable(
  "networks",
  {
    id: id(),
    ...tenancy(),
    cidr: cidr("cidr").notNull(),
    name: text("name"),
    vlan: integer("vlan"),
    status: networkStatus("status").notNull().default("unknown"),
    source: text("source", { enum: ["user", "agent", "sensor", "integration"] }).notNull(),
    notes: text("notes"),
    ...timestamps(),
  },
  (t) => [uniqueIndex("networks_org_cidr_idx").on(t.orgId, t.cidr)],
);

export const assets = pgTable(
  "assets",
  {
    id: id(),
    ...tenancy(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("unknown"), // server, workstation, router, switch, iot, vm, container, ...
    vendor: text("vendor"),
    model: text("model"),
    os: text("os"),
    primaryIp: inet("primary_ip"),
    primaryMac: text("primary_mac"),
    networkId: uuid("network_id").references(() => networks.id),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    hostnames: jsonb("hostnames").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    source: text("source").notNull(), // user | agent:<id> | sensor | integration:<key>
    confidence: integer("confidence").notNull().default(50), // 0-100
    locked: boolean("locked").notNull().default(false), // user-locked: agents may not overwrite
    status: text("status", { enum: ["active", "missing", "retired"] }).notNull().default("active"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index("assets_org_ip_idx").on(t.orgId, t.primaryIp), index("assets_org_mac_idx").on(t.orgId, t.primaryMac)],
);

export const assetServices = pgTable(
  "asset_services",
  {
    id: id(),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    port: integer("port").notNull(),
    name: text("name"),
    product: text("product"),
    version: text("version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("asset_services_port_idx").on(t.assetId, t.protocol, t.port)],
);

export const assetRelationships = pgTable("asset_relationships", {
  id: id(),
  ...tenancy(),
  fromAssetId: uuid("from_asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  toAssetId: uuid("to_asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // connected_to, hosts, depends_on, ...
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
});

// ---------------------------------------------------------------------------
// Incidents & change management
// ---------------------------------------------------------------------------
export const priority = pgEnum("priority", ["P1", "P2", "P3", "P4"]);

export const incidents = pgTable("incidents", {
  id: id(),
  ...tenancy(),
  number: integer("number").generatedAlwaysAsIdentity(),
  type: text("type", { enum: ["break_fix", "security", "request"] }).notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  priority: priority("priority").notNull().default("P3"),
  status: text("status", { enum: ["new", "in_progress", "on_hold", "resolved", "closed"] }).notNull().default("new"),
  raisedByUserId: uuid("raised_by_user_id").references(() => users.id),
  raisedByAgentId: uuid("raised_by_agent_id").references(() => agents.id),
  assignedUserId: uuid("assigned_user_id").references(() => users.id),
  assignedAgentId: uuid("assigned_agent_id").references(() => agents.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  ...timestamps(),
});

export const incidentComments = pgTable("incident_comments", {
  id: id(),
  incidentId: uuid("incident_id").notNull().references(() => incidents.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").references(() => users.id),
  authorAgentId: uuid("author_agent_id").references(() => agents.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incidentAssets = pgTable(
  "incident_assets",
  {
    incidentId: uuid("incident_id").notNull().references(() => incidents.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.incidentId, t.assetId] })],
);

export const changeType = pgEnum("change_type", ["standard", "normal", "emergency"]);
export const changeStatus = pgEnum("change_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "scheduled",
  "in_progress",
  "verifying",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
]);

/** A single planned tool call recorded on a change request; the gate only executes calls that match one. */
export interface PlannedToolCall {
  tool: string;
  args: Record<string, unknown>;
  target?: string;
}

export const changeRequests = pgTable("change_requests", {
  id: id(),
  ...tenancy(),
  number: integer("number").generatedAlwaysAsIdentity(),
  type: changeType("type").notNull(),
  status: changeStatus("status").notNull().default("draft"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  risk: text("risk", { enum: ["low", "medium", "high"] }).notNull(),
  plannedCalls: jsonb("planned_calls").$type<PlannedToolCall[]>().notNull().default([]),
  /** Tool calls that undo the change; executable while the change is in progress or verifying. */
  rollbackCalls: jsonb("rollback_calls").$type<PlannedToolCall[]>().notNull().default([]),
  rollbackPlan: text("rollback_plan").notNull(),
  verificationPlan: text("verification_plan").notNull(),
  standardTemplateKey: text("standard_template_key"),
  incidentId: uuid("incident_id").references(() => incidents.id),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
  requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
  windowStart: timestamp("window_start", { withTimezone: true }),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  postReviewRequired: boolean("post_review_required").notNull().default(false),
  ...timestamps(),
});

export const changeApprovals = pgTable("change_approvals", {
  id: id(),
  changeId: uuid("change_id").notNull().references(() => changeRequests.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const changeAssets = pgTable(
  "change_assets",
  {
    changeId: uuid("change_id").notNull().references(() => changeRequests.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.assetId] })],
);

/** Timeline of a change: comments, execution results and system transitions. */
export const changeNotes = pgTable("change_notes", {
  id: id(),
  changeId: uuid("change_id").notNull().references(() => changeRequests.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id").references(() => users.id),
  authorAgentId: uuid("author_agent_id").references(() => agents.id),
  kind: text("kind", { enum: ["comment", "execution", "system"] }).notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Pre-approved standard changes. Each call is a tool plus argument templates; "{param}"
 * placeholders must match the regex in `params`. A change built from a template runs
 * without waiting for an approver.
 */
export interface StandardChangeCall {
  tool: string;
  args: Record<string, unknown>;
}

export const standardChangeTemplates = pgTable(
  "standard_change_templates",
  {
    id: id(),
    ...tenancy(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    risk: text("risk", { enum: ["low", "medium", "high"] }).notNull().default("low"),
    calls: jsonb("calls").$type<StandardChangeCall[]>().notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex("standard_change_templates_org_key_idx").on(t.orgId, t.key)],
);

// ---------------------------------------------------------------------------
// Monitoring: built-in checks (run by the gate) and external monitors fed by webhooks.
// ---------------------------------------------------------------------------
export const monitorKind = pgEnum("monitor_kind", ["ping", "tcp", "http", "tls", "dns", "external"]);
export const monitorState = pgEnum("monitor_state", ["pending", "up", "degraded", "down", "paused"]);

/** Kind-specific check settings. Validated by the core service; the gate builds tool args from it. */
export interface MonitorConfig {
  port?: number;
  scheme?: "http" | "https";
  path?: string;
  method?: "GET" | "HEAD";
  expectStatus?: number[];
  keyword?: string;
  verifyTls?: boolean;
  /** TLS: degraded when the certificate expires within this many days. */
  warnDays?: number;
  /** DNS: record type and an answer that must be present. */
  recordType?: "A" | "AAAA" | "PTR";
  expectAnswer?: string;
  /** Degraded when latency is above this. */
  degradedMs?: number;
  /** Raise a (P4) incident when degraded, not only a notification. */
  incidentOnDegraded?: boolean;
}

export interface MonitorResultSummary {
  ok: boolean;
  degraded?: boolean;
  latencyMs?: number | null;
  message: string;
  at: string;
  flapping?: boolean;
  suppressed?: boolean;
  /** The gate refused the check (target outside allowed networks). */
  policyDenied?: boolean;
}

export const monitorSources = pgTable("monitor_sources", {
  id: id(),
  ...tenancy(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["uptime_kuma", "beszel", "alertmanager", "generic"] }).notNull(),
  /** sha256 of the bearer token; the token itself is shown once on creation. */
  tokenHash: text("token_hash").notNull(),
  /** Applied to monitors this source creates; editable per monitor afterwards. */
  defaultPriority: priority("default_priority").notNull().default("P3"),
  defaultResponderAgentId: uuid("default_responder_agent_id").references(() => agents.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
  ...timestamps(),
});

export const monitors = pgTable(
  "monitors",
  {
    id: id(),
    ...tenancy(),
    name: text("name").notNull(),
    kind: monitorKind("kind").notNull(),
    /** Hostname or IP for built-in checks; display only for external monitors. */
    target: text("target").notNull().default(""),
    config: jsonb("config").$type<MonitorConfig>().notNull().default({}),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    timeoutSeconds: integer("timeout_seconds").notNull().default(10),
    failureThreshold: integer("failure_threshold").notNull().default(3),
    recoveryThreshold: integer("recovery_threshold").notNull().default(2),
    priority: priority("priority").notNull().default("P3"),
    responderAgentId: uuid("responder_agent_id").references(() => agents.id, { onDelete: "set null" }),
    responderUserId: uuid("responder_user_id").references(() => users.id, { onDelete: "set null" }),
    autoResolve: boolean("auto_resolve").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    state: monitorState("state").notNull().default("pending"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastResult: jsonb("last_result").$type<MonitorResultSummary>(),
    openIncidentId: uuid("open_incident_id").references(() => incidents.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => monitorSources.id, { onDelete: "cascade" }),
    externalKey: text("external_key"),
    ...timestamps(),
  },
  (t) => [
    index("monitors_due_idx").on(t.enabled, t.nextCheckAt),
    uniqueIndex("monitors_source_key_idx").on(t.sourceId, t.externalKey),
    index("monitors_asset_idx").on(t.assetId),
  ],
);

export const monitorResults = pgTable(
  "monitor_results",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    degraded: boolean("degraded").notNull().default(false),
    latencyMs: integer("latency_ms"),
    message: text("message").notNull().default(""),
  },
  (t) => [index("monitor_results_monitor_at_idx").on(t.monitorId, t.at)],
);

export const monitorStateChanges = pgTable(
  "monitor_state_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
    from: monitorState("from").notNull(),
    to: monitorState("to").notNull(),
    reason: text("reason").notNull().default(""),
    /** Raised during an in-progress change on the monitored asset: no incident. */
    suppressed: boolean("suppressed").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("monitor_state_changes_monitor_at_idx").on(t.monitorId, t.at)],
);

// ---------------------------------------------------------------------------
// Events outbox: domain events written in the same transaction as the change that
// caused them; the worker dispatches them (start agent runs, send notifications).
// ---------------------------------------------------------------------------
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Retry backoff: the event is not claimed before this time. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_pending_idx").on(t.processedAt, t.id)],
);

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    ...tenancy(),
    name: text("name").notNull(), // referenced by agents as secret:<name>
    type: text("type", { enum: ["password", "ssh_key", "api_token", "snmp_community", "other"] }).notNull(),
    description: text("description"),
    // Envelope encryption: value encrypted with a per-secret data key, data key wrapped by the master key.
    ciphertext: text("ciphertext").notNull(),
    wrappedDataKey: text("wrapped_data_key").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    allowedHosts: jsonb("allowed_hosts").$type<string[]>().notNull().default([]),
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull().default([]),
    rotateAfterDays: integer("rotate_after_days"),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("secrets_org_name_idx").on(t.orgId, t.name)],
);

export const secretGrants = pgTable(
  "secret_grants",
  {
    secretId: uuid("secret_id").notNull().references(() => secrets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.secretId, t.agentId] })],
);

// ---------------------------------------------------------------------------
// Platform: audit, notifications, settings
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ...tenancy(),
    actorType: text("actor_type", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(), // e.g. tool.call, change.approve, secret.use
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    // Hash chain: hash = sha256(prevHash || canonical(entry)) makes tampering detectable.
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_time_idx").on(t.orgId, t.createdAt)],
);

export const notifications = pgTable("notifications", {
  id: id(),
  ...tenancy(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  link: text("link"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable(
  "settings",
  {
    orgId: uuid("org_id").notNull(),
    key: text("key").notNull(), // e.g. agents.kill_switch, changes.allow_emergency
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);
