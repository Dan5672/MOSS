import { settings, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";

export const SETTING_DEFAULTS = {
  "agents.kill_switch": false,
  "tools.allow_dangerous": false,
  "changes.allow_emergency": false,
  "changes.require_separate_approver": false,
  "monitoring.retention_days": 14,
  /** A remote tools catalog (https URL of its index); empty for the bundled catalog only. */
  "tools.catalog_url": "" as string,
  /** vuln_scan's "cve" profile sends service names and versions to vulners.com, so it is off until allowed. */
  "tools.allow_vulners": false,
  /** Until when (ISO time) monitors stay quiet: no new incidents. Set from Home Assistant's maintenance mode. */
  "monitoring.quiet_until": "" as string,
  /** Whether Home Assistant may resume agents (pausing them is always allowed). */
  "homeassistant.allow_resume": false,
} satisfies Record<string, unknown>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K];

export async function getSetting<K extends SettingKey>(db: Database, orgId: string, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select().from(settings).where(and(eq(settings.orgId, orgId), eq(settings.key, key)));
  return (row?.value as SettingValue<K> | undefined) ?? SETTING_DEFAULTS[key];
}

export async function setSetting<K extends SettingKey>(db: Database, orgId: string, key: K, value: SettingValue<K>) {
  await db
    .insert(settings)
    .values({ orgId, key, value })
    .onConflictDoUpdate({ target: [settings.orgId, settings.key], set: { value, updatedAt: new Date() } });
}
