// An integration's stored config and state (in the modules table, under its key), read through one schema so a
// bad or old value falls back to defaults instead of breaking it.
import type { Database } from "@moss/db";
import { z } from "zod";
import { loadModule } from "../services/modules.js";
import type { IntegrationConfig, IntegrationDef, IntegrationState } from "./types.js";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function integrationConfigSchema(def: IntegrationDef) {
  const featureDefaults = Object.fromEntries(def.features.map((f) => [f.key, false]));
  return z.object({
    host: z.string().regex(IPV4, `${def.name}'s IPv4 address, e.g. 192.168.1.10`).optional().catch(undefined),
    port: z.number().int().min(1).max(65535).default(def.connection.defaultPort).catch(def.connection.defaultPort),
    scheme: z
      .enum(["http", "https"])
      .default(def.connection.scheme?.default ?? "https")
      .catch(def.connection.scheme?.default ?? "https"),
    verifyTls: z.boolean().default(false).catch(false),
    user: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[^\s:]+$/, "No spaces or colons")
      .optional()
      .catch(undefined),
    features: z
      .record(z.string(), z.boolean())
      .transform((f) => ({ ...featureDefaults, ...Object.fromEntries(Object.entries(f).filter(([k]) => k in featureDefaults)) }))
      .default(featureDefaults)
      .catch(featureDefaults),
    priority: z.enum(["P1", "P2", "P3", "P4"]).default("P3").catch("P3"),
    responderAgentId: z.uuid().optional().catch(undefined),
    options: z.record(z.string(), z.unknown()).default({}).catch({}),
  });
}

export function parseIntegrationConfig(def: IntegrationDef, raw: unknown): IntegrationConfig {
  return integrationConfigSchema(def).parse(raw && typeof raw === "object" ? raw : {}) as IntegrationConfig;
}

export async function loadIntegration(db: Pick<Database, "select">, orgId: string, def: IntegrationDef) {
  const row = await loadModule(db, orgId, def.key);
  return { enabled: row.enabled, config: parseIntegrationConfig(def, row.config), state: row.state as IntegrationState, updatedAt: row.updatedAt };
}

/** The connection arguments every one of its tools takes. The credential is a handle; only the gate resolves it. */
export function integrationArgs(def: IntegrationDef, c: IntegrationConfig): Record<string, unknown> {
  if (!c.host) throw new Error(`Set ${def.name}'s address first`);
  return {
    target: c.host,
    port: c.port,
    ...(def.connection.scheme ? { scheme: c.scheme } : {}),
    verifyTls: c.verifyTls,
    ...(def.connection.user ? { user: c.user } : {}),
    [def.credential.arg]: `secret:${def.credential.secretName}`,
  };
}
