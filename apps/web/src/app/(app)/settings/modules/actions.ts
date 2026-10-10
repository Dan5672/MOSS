"use server";

import {
  applyHomeAssistantDevices,
  createIntegrationToken,
  createMonitorSource,
  HA_SELF_HEAL_AGENT_TOOLS,
  HA_SELF_HEAL_TEMPLATE,
  HA_SKILL,
  HA_TOKEN_SECRET,
  HA_TOKEN_TOOLS,
  haConfigSchema,
  loadHomeAssistant,
  revokeIntegrationToken,
  rotateMonitorSourceToken,
  saveModule,
  selfHealTemplate,
  setSetting,
  updateModuleState,
  upsertStandardTemplate,
  writeAudit,
  type HaConfig,
  type HomeAssistantDevices,
  type HomeAssistantHealth,
} from "@moss/core";
import { agents, agentSchedules, agentSkills, agentToolOverrides, monitors, monitorSources, secretGrants, secrets, skills, standardChangeTemplates } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { describeCron } from "@/lib/schedule";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { homeAssistantCall } from "@/server/home-assistant";
import { storeSecret } from "@/server/services";

type Feature = "alerts" | "health" | "notify" | "sensors" | "inventory" | "selfHeal" | "logReview";

const actor = (u: CurrentUser) => ({ type: "user" as const, id: u.id });
const on = (v: FormDataEntryValue | null) => v === "on" || v === "true";

async function current(orgId: string) {
  return loadHomeAssistant(db(), orgId);
}

/** Saves a new config, validating it the same way every reader does. */
async function save(user: CurrentUser, config: HaConfig, enabled?: boolean) {
  const parsed = haConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  await saveModule(db(), user.orgId, "home_assistant", { enabled, config: parsed.data }, actor(user));
}

/** The org's agent, or an error. */
async function ownAgent(orgId: string, agentId: string | undefined) {
  if (!agentId) throw new Error("Choose an agent");
  const [a] = await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!a || a.status === "fired") throw new Error("Agent not found");
  return a;
}

async function tokenSecret(orgId: string) {
  const [s] = await db().select().from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, HA_TOKEN_SECRET)));
  return s ?? null;
}

/** Lets the agent use the Home Assistant token (the gate still checks its host and tool scope). */
async function grantToken(user: CurrentUser, agentId: string) {
  const s = await tokenSecret(user.orgId);
  if (!s) throw new Error("Add Home Assistant's access token first (Connection)");
  await db().insert(secretGrants).values({ secretId: s.id, agentId, grantedBy: user.id }).onConflictDoNothing();
}

/**
 * Keeps the module's webhook source and log-review schedule in step with the module and its features:
 * nothing of the module's runs while it is off.
 */
async function syncSideEffects(orgId: string) {
  const { enabled, config: c } = await current(orgId);
  if (c.sourceId) {
    await db()
      .update(monitorSources)
      .set({ enabled: enabled && (c.alerts.enabled || c.health.enabled), updatedAt: new Date() })
      .where(and(eq(monitorSources.id, c.sourceId), eq(monitorSources.orgId, orgId)));
  }
  if (c.logReview.scheduleId) {
    await db()
      .update(agentSchedules)
      .set({ enabled: enabled && c.logReview.enabled })
      .where(and(eq(agentSchedules.id, c.logReview.scheduleId), eq(agentSchedules.orgId, orgId)));
  }
  await db()
    .update(standardChangeTemplates)
    .set({ enabled: enabled && c.selfHeal.enabled, updatedAt: new Date() })
    .where(and(eq(standardChangeTemplates.orgId, orgId), eq(standardChangeTemplates.key, HA_SELF_HEAL_TEMPLATE)));
}

export async function setHomeAssistantEnabledAction(enabled: boolean): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const { config } = await current(user.orgId);
    await save(user, config, enabled);
    await syncSideEffects(user.orgId);
    return enabled ? "Home Assistant module switched on." : "Home Assistant module switched off: nothing of it runs, and agents can't use its tools.";
  });
}

const connectionSchema = z.object({
  host: z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "Home Assistant's IPv4 address, e.g. 10.0.0.20"),
  port: z.coerce.number().int().min(1).max(65535),
  scheme: z.enum(["http", "https"]),
  mossUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/]+(:\d+)?\/?$/, "MOSS's address as your phone reaches it, e.g. http://10.0.0.5:3080")
    .optional(),
  token: z.string().min(20, "That doesn't look like a long-lived access token").max(1000).optional(),
});

export async function saveHomeAssistantConnectionAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    // The token is a secret: storing it, or moving it to another address, takes the secrets permission too.
    if (!user.permissions.has("secrets.manage")) throw new Error("Changing the connection also needs permission to manage secrets");
    const f = connectionSchema.parse(formObject(form));
    const { config } = await current(user.orgId);
    const existing = await tokenSecret(user.orgId);
    if (f.token) {
      await storeSecret({
        userId: user.id,
        name: HA_TOKEN_SECRET,
        type: "api_token",
        value: f.token,
        description: "Home Assistant long-lived access token (Home Assistant module)",
        allowedHosts: [f.host],
        allowedTools: HA_TOKEN_TOOLS,
      });
    } else if (!existing) {
      throw new Error("Paste a long-lived access token (Home Assistant: your profile > Security > Long-lived access tokens)");
    } else if (existing.allowedHosts.join() !== f.host) {
      // The token may only ever go to the address it is configured for.
      await db().update(secrets).set({ allowedHosts: [f.host], updatedAt: new Date() }).where(eq(secrets.id, existing.id));
      await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "secret.scope", targetType: "secret", targetId: existing.id, details: { allowedHosts: [f.host] } });
    }
    await save(user, { ...config, host: f.host, port: f.port, scheme: f.scheme, verifyTls: on(form.get("verifyTls")), mossUrl: f.mossUrl?.replace(/\/+$/, "") });
    if (config.selfHeal.enabled) await refreshSelfHealTemplate(user);
    return f.token ? "Saved the connection and the token." : "Saved the connection.";
  });
}

export async function testHomeAssistantAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const res = await homeAssistantCall(user.id, "test");
    if (!res.ok) throw new Error(res.error);
    const h = res.result as HomeAssistantHealth;
    const failed = h.integrations?.failed.length ?? 0;
    return [
      `Connected to Home Assistant ${h.version ?? ""}${h.locationName ? ` (${h.locationName})` : ""}: ${h.entities} entities.`,
      h.integrations ? `${failed ? `${failed} integration(s) not working` : "All integrations loaded"}.` : "Its integration list needs an administrator's token.",
      h.updates.length ? `${h.updates.length} update(s) available.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
}

/** The webhook source alerts and health checks arrive through, created on first use. */
async function ensureSource(user: CurrentUser, config: HaConfig, defaults: { priority: "P1" | "P2" | "P3" | "P4"; responder: string | null }) {
  if (config.sourceId) {
    const [s] = await db().select({ id: monitorSources.id }).from(monitorSources).where(and(eq(monitorSources.id, config.sourceId), eq(monitorSources.orgId, user.orgId)));
    if (s) {
      await db().update(monitorSources).set({ defaultPriority: defaults.priority, defaultResponderAgentId: defaults.responder, updatedAt: new Date() }).where(eq(monitorSources.id, s.id));
      return { sourceId: s.id, token: null };
    }
  }
  const { source, token } = await createMonitorSource(
    db(),
    user.orgId,
    { name: "Home Assistant", kind: "generic", defaultPriority: defaults.priority, defaultResponderAgentId: defaults.responder },
    actor(user),
    { moduleKind: "home_assistant" },
  );
  return { sourceId: source.id, token };
}

const prioritySchema = z.enum(["P1", "P2", "P3", "P4"]);
const optionalId = z.uuid().optional();

export type AlertsSaved = (ActionState & { token?: string; sourceId?: string }) | undefined;

/** Alerts and health checks share the webhook source, its default priority and responder. */
export async function saveHomeAssistantAlertsAction(_: AlertsSaved, form: FormData): Promise<AlertsSaved> {
  let created: { token: string; sourceId: string } | undefined;
  const state = await act(async () => {
    const user = await requirePermission("integrations.manage");
    if (!user.permissions.has("monitoring.manage")) throw new Error("Alerts and health checks also need permission to manage monitoring");
    const f = z
      .object({ priority: prioritySchema, responder: optionalId, unavailableThreshold: z.coerce.number().int().min(1).max(10_000) })
      .parse(formObject(form));
    if (f.responder) await ownAgent(user.orgId, f.responder);
    const { config } = await current(user.orgId);
    const alerts = on(form.get("alerts"));
    const health = on(form.get("health"));
    let sourceId = config.sourceId;
    if (alerts || health) {
      const s = await ensureSource(user, config, { priority: f.priority, responder: f.responder ?? null });
      sourceId = s.sourceId;
      if (s.token) created = { token: s.token, sourceId: s.sourceId };
    }
    await save(user, { ...config, sourceId, alerts: { enabled: alerts }, health: { enabled: health, unavailableThreshold: f.unavailableThreshold } });
    await syncSideEffects(user.orgId);
    return created ? "Saved. Copy the webhook token now: it is not shown again." : "Saved alerts and health checks.";
  });
  return { ...state, ...created };
}

/** A new webhook token (the old one stops working), shown once. */
export async function newHomeAssistantTokenAction(_: AlertsSaved): Promise<AlertsSaved> {
  let created: { token: string; sourceId: string } | undefined;
  const state = await act(async () => {
    const user = await requirePermission("integrations.manage");
    const { config } = await current(user.orgId);
    if (!config.sourceId) throw new Error("Switch on alerts first");
    created = { token: await rotateMonitorSourceToken(db(), user.orgId, config.sourceId, actor(user)), sourceId: config.sourceId };
    return "New webhook token issued; the old one no longer works. Update Home Assistant's rest_command.";
  });
  return { ...state, ...created };
}

export async function saveHomeAssistantNotifyAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const enabled = on(form.get("enabled"));
    const services = [...new Set((form.get("services")?.toString() ?? "").split(/[\s,]+/).map((s) => s.replace(/^notify\./, "")).filter(Boolean))];
    if (enabled && !services.length) throw new Error("Name at least one notify service, e.g. mobile_app_pixel_8");
    const minPriority = prioritySchema.parse(form.get("minPriority"));
    const { config } = await current(user.orgId);
    await save(user, { ...config, notify: { enabled, services, minPriority } });
    return enabled ? `New ${minPriority === "P1" ? "P1" : `P1-${minPriority}`} incidents will be sent to ${services.map((s) => `notify.${s}`).join(", ")}.` : "Phone notifications switched off.";
  });
}

export async function saveHomeAssistantSimpleAction(feature: "sensors" | "inventory", _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    if (feature === "inventory" && !user.permissions.has("assets.manage")) throw new Error("Inventory sync also needs permission to manage assets");
    const enabled = on(form.get("enabled"));
    const { config } = await current(user.orgId);
    await save(user, { ...config, [feature]: { enabled } });
    if (feature === "sensors") return enabled ? "MOSS will keep its sensor.moss_* entities up to date in Home Assistant." : "Status sensors switched off.";
    return enabled ? "Inventory sync switched on: it runs daily, or now with Sync now." : "Inventory sync switched off.";
  });
}

export async function syncHomeAssistantInventoryAction(_: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("assets.manage");
    if (!user.permissions.has("integrations.manage")) throw new Error("You don't have permission to manage modules");
    const res = await homeAssistantCall(user.id, "devices");
    if (!res.ok) {
      await updateModuleState(db(), user.orgId, "home_assistant", { lastInventoryAt: new Date().toISOString(), lastInventory: { error: res.error } });
      throw new Error(res.error);
    }
    const r = await applyHomeAssistantDevices(db(), user.orgId, (res.result as HomeAssistantDevices).devices);
    await updateModuleState(db(), user.orgId, "home_assistant", { lastInventoryAt: new Date().toISOString(), lastInventory: r });
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "module.inventory_sync", targetType: "module", targetId: "home_assistant", details: { ...r } });
    return `Matched ${r.matched} device(s) to the inventory${r.locked ? ` (${r.locked} locked, left alone)` : ""}, added ${r.created}, skipped ${r.skipped} with no address on an allowed network.`;
  });
}

async function refreshSelfHealTemplate(user: CurrentUser) {
  const { config } = await current(user.orgId);
  const [m] = config.selfHeal.monitorId ? await db().select({ name: monitors.name }).from(monitors).where(eq(monitors.id, config.selfHeal.monitorId)) : [];
  await upsertStandardTemplate(db(), user.orgId, selfHealTemplate(config, m?.name ?? "the monitor"), user.id);
  await syncSideEffects(user.orgId);
}

export async function saveHomeAssistantSelfHealAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const enabled = on(form.get("enabled"));
    const { config } = await current(user.orgId);
    if (!enabled) {
      await save(user, { ...config, selfHeal: { ...config.selfHeal, enabled: false } });
      await syncSideEffects(user.orgId);
      return "Self-heal switched off. Nothing will be power-cycled automatically.";
    }
    // Defining it pre-approves a power-cycle, and gives an agent the tools to carry it out.
    if (!user.permissions.has("changes.approve") || !user.permissions.has("agents.manage")) {
      throw new Error("Self-heal also needs permission to approve changes and manage agents: it pre-approves the power-cycle");
    }
    const f = z
      .object({
        monitorId: z.uuid("Choose the monitor that watches the internet"),
        entity: z.string().regex(/^switch\.[a-z0-9_]{1,64}$/, "The plug's switch entity, e.g. switch.modem_plug"),
        offSeconds: z.coerce.number().int().min(5).max(120),
        afterMinutes: z.coerce.number().int().min(1).max(120),
        agentId: z.uuid("Choose the agent that carries it out"),
      })
      .parse(formObject(form));
    const [m] = await db().select({ id: monitors.id }).from(monitors).where(and(eq(monitors.id, f.monitorId), eq(monitors.orgId, user.orgId)));
    if (!m) throw new Error("Monitor not found");
    const agent = await ownAgent(user.orgId, f.agentId);
    if (!config.host) throw new Error("Set up the connection first");
    await grantToken(user, agent.id);
    for (const tool of HA_SELF_HEAL_AGENT_TOOLS) {
      await db()
        .insert(agentToolOverrides)
        .values({ agentId: agent.id, tool, granted: true, setBy: user.id })
        .onConflictDoUpdate({ target: [agentToolOverrides.agentId, agentToolOverrides.tool], set: { granted: true, setBy: user.id, setAt: new Date() } });
    }
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "tool.access", targetType: "agent", targetId: agent.id, details: { granted: HA_SELF_HEAL_AGENT_TOOLS, reason: "Home Assistant self-heal" } });
    await save(user, { ...config, selfHeal: { enabled: true, ...f } });
    await refreshSelfHealTemplate(user);
    return `Self-heal on: after ${f.afterMinutes} minute(s) down, ${agent.name} will power-cycle ${f.entity} through a pre-approved change.`;
  });
}

const LOG_REVIEW_TASK =
  "Review Home Assistant's error log for anomalies, following your Home Assistant skill: compare the last 24 hours with your " +
  "log baseline, raise or update incidents only for real anomalies, and update the baseline.";

export async function saveHomeAssistantLogReviewAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const enabled = on(form.get("enabled"));
    const { config } = await current(user.orgId);
    if (!enabled) {
      await save(user, { ...config, logReview: { ...config.logReview, enabled: false } });
      await syncSideEffects(user.orgId);
      return "Log review switched off.";
    }
    if (!user.permissions.has("agents.manage")) throw new Error("Log review also needs permission to manage agents");
    const f = z.object({ agentId: z.uuid("Choose the agent that reviews the logs"), hour: z.coerce.number().int().min(0).max(23) }).parse(formObject(form));
    const agent = await ownAgent(user.orgId, f.agentId);
    if (!config.host) throw new Error("Set up the connection first");
    const [skill] = await db().select({ id: skills.id }).from(skills).where(and(eq(skills.orgId, user.orgId), eq(skills.key, HA_SKILL)));
    if (!skill) throw new Error("The Home Assistant skill isn't installed yet; it appears once the worker has restarted after the upgrade");
    await db().insert(agentSkills).values({ agentId: agent.id, skillId: skill.id, grantedBy: user.id }).onConflictDoNothing();
    await grantToken(user, agent.id);
    const cron = `0 ${f.hour} * * *`;
    let scheduleId = config.logReview.scheduleId;
    const [existing] = scheduleId ? await db().select({ id: agentSchedules.id }).from(agentSchedules).where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.orgId, user.orgId))) : [];
    if (existing) {
      await db().update(agentSchedules).set({ agentId: agent.id, cron, task: LOG_REVIEW_TASK, enabled: true }).where(eq(agentSchedules.id, existing.id));
    } else {
      const [row] = await db().insert(agentSchedules).values({ orgId: user.orgId, agentId: agent.id, cron, task: LOG_REVIEW_TASK, enabled: true }).returning({ id: agentSchedules.id });
      scheduleId = row!.id;
    }
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "agent.skill_add", targetType: "agent", targetId: agent.id, details: { skill: HA_SKILL, reason: "Home Assistant log review", cron } });
    await save(user, { ...config, logReview: { enabled: true, agentId: agent.id, scheduleId, cron } });
    await syncSideEffects(user.orgId);
    return `${agent.name} will review Home Assistant's log ${describeCron(cron).toLowerCase()}.`;
  });
}

export type { Feature };

// --- The MOSS integration for Home Assistant: tokens it signs in with, and what it may do ---------------

export type TokenCreated = (NonNullable<ActionState> & { token?: string }) | undefined;

/** Makes a token for the Home Assistant integration. It's shown once; MOSS keeps only its hash. */
export async function createHomeAssistantTokenAction(_: TokenCreated, form: FormData): Promise<TokenCreated> {
  let token: string | undefined;
  const state = await act(async () => {
    const user = await requirePermission("integrations.manage");
    const name = z.string().trim().max(60).parse(form.get("name") ?? "") || "Home Assistant";
    ({ token } = await createIntegrationToken(db(), user.orgId, user.id, name));
    return "Token made. Copy it now: it won't be shown again.";
  });
  return { ...state, token };
}

export async function revokeHomeAssistantTokenAction(tokenId: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    await revokeIntegrationToken(db(), user.orgId, tokenId, user.id);
    return "Token revoked: anything using it is signed out.";
  });
}

export async function setHomeAssistantAllowResumeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("settings.manage");
    const allow = on(form.get("allowResume"));
    await setSetting(db(), user.orgId, "homeassistant.allow_resume", allow);
    await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "setting.update", targetType: "setting", targetId: "homeassistant.allow_resume", details: { value: allow } });
    return allow ? "Home Assistant may now resume agents." : "Home Assistant can pause agents but not resume them.";
  });
}
