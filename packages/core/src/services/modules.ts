// Optional modules: switched on and configured per org. Each module validates its own config on every
// read, so a bad or old stored value falls back to defaults instead of breaking the module's users.
import { modules, type Database } from "@moss/db";
import { and, eq, sql } from "drizzle-orm";
import { writeAudit } from "../store/audit-store.js";
import type { Actor } from "./assets.js";

export const MODULE_KEYS = ["home_assistant"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
/** What each integration is called on screen (and in Moss's docs, which a test checks). */
export const MODULE_NAMES: Record<ModuleKey, string> = { home_assistant: "Home Assistant" };

/** The module a built-in tool belongs to: its tools only work while the module is on. */
export function moduleForTool(tool: string): ModuleKey | null {
  return tool.startsWith("homeassistant_") ? "home_assistant" : null;
}

export interface ModuleRow {
  enabled: boolean;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  updatedAt: Date | null;
}

export async function loadModule(db: Pick<Database, "select">, orgId: string, key: ModuleKey): Promise<ModuleRow> {
  const [row] = await db.select().from(modules).where(and(eq(modules.orgId, orgId), eq(modules.key, key)));
  return row ? { enabled: row.enabled, config: row.config, state: row.state, updatedAt: row.updatedAt } : { enabled: false, config: {}, state: {}, updatedAt: null };
}

export async function isModuleEnabled(db: Pick<Database, "select">, orgId: string, key: ModuleKey): Promise<boolean> {
  return (await loadModule(db, orgId, key)).enabled;
}

/** Orgs that have a module switched on. */
export async function orgsWithModule(db: Pick<Database, "select">, key: ModuleKey): Promise<string[]> {
  const rows = await db.select({ orgId: modules.orgId }).from(modules).where(and(eq(modules.key, key), eq(modules.enabled, true)));
  return rows.map((r) => r.orgId);
}

/** Switches a module on or off and/or replaces its config. Audited with the before/after config. */
export async function saveModule(db: Database, orgId: string, key: ModuleKey, patch: { enabled?: boolean; config?: Record<string, unknown> }, actor: Actor) {
  const before = await loadModule(db, orgId, key);
  const enabled = patch.enabled ?? before.enabled;
  const config = patch.config ?? before.config;
  const userId = actor.type === "user" ? actor.id : null;
  await db
    .insert(modules)
    .values({ orgId, key, enabled, config, updatedBy: userId })
    .onConflictDoUpdate({ target: [modules.orgId, modules.key], set: { enabled, config, updatedBy: userId, updatedAt: new Date() } });
  const action = patch.enabled === undefined || patch.enabled === before.enabled ? "module.configure" : enabled ? "module.enable" : "module.disable";
  await writeAudit(db, { orgId, actorType: actor.type, actorId: actor.id, action, targetType: "module", targetId: key, details: { before: before.config, after: config } });
}

/** Merges keys into a module's runtime state (what MOSS recorded while running it). Not audited. */
export async function updateModuleState(db: Database, orgId: string, key: ModuleKey, patch: Record<string, unknown>) {
  await db
    .insert(modules)
    .values({ orgId, key, state: patch })
    .onConflictDoUpdate({ target: [modules.orgId, modules.key], set: { state: sql`${modules.state} || ${JSON.stringify(patch)}::jsonb` } });
}
