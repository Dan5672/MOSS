"use server";

import {
  applyFeatureRun,
  getIntegration, integrationLicensed,
  integrationConfigSchema,
  loadIntegration,
  pauseIntegrationSource,
  saveModule,
  writeAudit,
  integrationConfigured,
  type IntegrationConfig,
  type IntegrationDef,
} from "@moss/core";
import { agents, secrets } from "@moss/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { act, formObject, type ActionState } from "@/server/action";
import { requirePermission, type CurrentUser } from "@/server/auth";
import { db } from "@/server/db";
import { integrationCall } from "@/server/integrations";
import { storeSecret } from "@/server/services";

const on = (v: FormDataEntryValue | null) => v === "on" || v === "true";
const actor = (u: CurrentUser) => ({ type: "user" as const, id: u.id });

/** The integration, if this org may use it (a business one needs a licence that covers it). */
async function definition(key: string, orgId: string): Promise<IntegrationDef> {
  const def = getIntegration(key);
  if (!def) throw new Error("Unknown integration");
  if (!(await integrationLicensed(db(), orgId, def))) throw new Error(`${def.name} needs a business licence: add one in Settings → About.`);
  return def;
}

async function save(user: CurrentUser, def: IntegrationDef, config: IntegrationConfig, enabled?: boolean) {
  const parsed = integrationConfigSchema(def).safeParse(config);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  await saveModule(db(), user.orgId, def.key, { enabled, config: parsed.data }, actor(user));
  revalidatePath(`/settings/integrations/${def.key}`);
}

async function credentialRow(orgId: string, def: IntegrationDef) {
  if (!def.credential) return null;
  const [s] = await db().select().from(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.name, def.credential.secretName)));
  return s ?? null;
}

/** Whether its connection is complete: an address (or hosts), and the credential unless it needs none. */
async function connectionReady(orgId: string, def: IntegrationDef, config: IntegrationConfig) {
  if (!integrationConfigured(def, config)) return false;
  return !def.credential || def.credential.optional || !!(await credentialRow(orgId, def));
}

export async function setIntegrationEnabledAction(key: string, enabled: boolean): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = await definition(key, user.orgId);
    const { config, state } = await loadIntegration(db(), user.orgId, def);
    if (enabled && !(await connectionReady(user.orgId, def, config))) throw new Error("Set up the connection first.");
    await save(user, def, config, enabled);
    if (!enabled) await pauseIntegrationSource(db(), user.orgId, state);
    return enabled ? `${def.name} is on.` : `${def.name} is off. Its features have stopped.`;
  });
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export async function saveIntegrationConnectionAction(key: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    // The credential is a secret: storing it, or pointing it at another address, takes the secrets permission too.
    if (!user.permissions.has("secrets.manage")) throw new Error("Changing the connection also needs permission to manage secrets.");
    const def = await definition(key, user.orgId);
    const f = formObject(form);
    const { config } = await loadIntegration(db(), user.orgId, def);
    const port = z.coerce.number().int().min(1).max(65535).parse(f.port ?? def.connection.defaultPort);
    // Several hosts: one per line, as an address or address:port.
    if (def.connection.multipleHosts) {
      const hosts = (f.hosts ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((line) => {
          const [h, p] = line.split(":");
          if (!IPV4.test(h ?? "")) throw new Error(`"${line}" isn't an IPv4 address (with an optional :port).`);
          return { host: h!, port: p ? z.coerce.number().int().min(1).max(65535).parse(p) : port };
        });
      if (!hosts.length) throw new Error("Add at least one host.");
      if (hosts.length > 20) throw new Error("At most 20 hosts.");
      await save(user, def, { ...config, hosts, port });
      return `Saved ${hosts.length} host${hosts.length === 1 ? "" : "s"}.`;
    }
    // A cloud service: only its credential (usable with its tools, from anywhere it calls).
    if (def.connection.cloud) {
      // Its named fields (a tenant id, an admin's email), each checked against what it must look like.
      const fields = Object.fromEntries(
        (def.connection.fields ?? []).map((fd) => {
          const v = (f[`field:${fd.key}`] ?? "").trim();
          if (!new RegExp(fd.pattern).test(v)) throw new Error(`${fd.label}: ${fd.message}.`);
          return [fd.key, v];
        }),
      );
      if (def.credential && !f.credential && !(await credentialRow(user.orgId, def))) throw new Error(`Enter the ${def.credential.label.toLowerCase()}.`);
      if (def.credential && f.credential) {
        await storeSecret({ userId: user.id, name: def.credential.secretName, type: def.credential.type, value: f.credential, description: `${def.credential.label} (${def.name} integration)`, allowedTools: def.credential.tools });
      }
      await save(user, def, { ...config, fields });
      return f.credential ? "Saved the connection and the credential." : "Saved the connection.";
    }
    const host = (f.host ?? "").trim();
    if (!IPV4.test(host)) throw new Error(`${def.name}'s address must be an IPv4 address.`);
    const existing = await credentialRow(user.orgId, def);
    if (def.credential && f.credential) {
      await storeSecret({
        userId: user.id,
        name: def.credential.secretName,
        type: def.credential.type,
        value: f.credential,
        ...(def.connection.user && f.user ? { username: f.user } : {}),
        description: `${def.credential.label} (${def.name} integration)`,
        allowedHosts: [host],
        allowedTools: def.credential.tools,
      });
    } else if (def.credential && !existing && !def.credential.optional) {
      throw new Error(`Enter the ${def.credential.label.toLowerCase()}.`);
    } else if (existing && existing.allowedHosts.join() !== host) {
      // The credential may only ever go to the address it's set up for.
      await db().update(secrets).set({ allowedHosts: [host], updatedAt: new Date() }).where(eq(secrets.id, existing.id));
      await writeAudit(db(), { orgId: user.orgId, actorType: "user", actorId: user.id, action: "secret.scope", targetType: "secret", targetId: existing.id, details: { allowedHosts: [host] } });
    }
    await save(user, def, {
      ...config,
      host,
      port,
      scheme: f.scheme === "http" ? "http" : "https",
      verifyTls: on(form.get("verifyTls")),
      ...(def.connection.user ? { user: f.user } : {}),
    });
    return f.credential ? "Saved the connection and the credential." : "Saved the connection.";
  });
}

export async function testIntegrationAction(key: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = await definition(key, user.orgId);
    const res = await integrationCall(user.id, key, "test");
    if (!res.ok) throw new Error(res.error);
    return def.test.describe(res.result);
  });
}

export async function saveIntegrationFeaturesAction(key: string, _: ActionState, form: FormData): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = await definition(key, user.orgId);
    const { config } = await loadIntegration(db(), user.orgId, def);
    const f = formObject(form);
    const responder = f.responderAgentId || undefined;
    if (responder) {
      const [a] = await db().select({ status: agents.status }).from(agents).where(and(eq(agents.id, responder), eq(agents.orgId, user.orgId)));
      if (!a || a.status === "fired") throw new Error("Agent not found.");
    }
    await save(user, def, {
      ...config,
      features: Object.fromEntries(def.features.map((ft) => [ft.key, on(form.get(`feature:${ft.key}`))])),
      options: {
        ...config.options,
        ...Object.fromEntries(
          (def.options ?? []).flatMap((o) => {
            const v = Number(form.get(`option:${o.key}`));
            if (!Number.isFinite(v)) return [];
            if (v < o.min || v > o.max) throw new Error(`${o.label}: between ${o.min} and ${o.max}.`);
            return [[o.key, v]];
          }),
        ),
      },
      priority: z.enum(["P1", "P2", "P3", "P4"]).parse(f.priority ?? "P3"),
      responderAgentId: responder,
    });
    return "Saved.";
  });
}

/** Runs a feature now (from the page), through the gate, and applies what it found. */
export async function syncIntegrationFeatureAction(key: string, featureKey: string, _: ActionState): Promise<ActionState> {
  return act(async () => {
    const user = await requirePermission("integrations.manage");
    const def = await definition(key, user.orgId);
    const feature = def.features.find((f) => f.key === featureKey);
    if (!feature) throw new Error("Unknown feature.");
    const { config, state } = await loadIntegration(db(), user.orgId, def);
    const res = await integrationCall(user.id, key, `sync:${featureKey}`);
    const run = await applyFeatureRun(db(), user.orgId, def, config, state, feature, res);
    revalidatePath(`/settings/integrations/${key}`);
    if (!run.ok) throw new Error(run.summary);
    return `${feature.label}: ${run.summary}`;
  });
}
