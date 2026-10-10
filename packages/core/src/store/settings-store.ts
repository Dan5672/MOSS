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
  /** The newest changelog version Moss has announced in #general. */
  "moss.announced_version": "" as string,
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

/**
 * What each setting does, in plain words. Required for every setting (the type checks it): Moss's
 * generated reference (library/docs/reference.md) is built from these.
 */
export const SETTING_DESCRIPTIONS = {
  "agents.kill_switch": "Stops every agent at once: no tool calls run until it's switched off (the kill switch at the bottom of the menu).",
  "tools.allow_dangerous": "Permits tools marked dangerous, such as factory resets, still only through approved changes. Off by default.",
  "changes.allow_emergency": "Lets agents raise emergency changes that run straight away and are reviewed afterwards. Off by default.",
  "changes.require_separate_approver": "Requires a change to be approved by someone other than the person who asked for it.",
  "monitoring.retention_days": "How many days of individual monitor check results are kept.",
  "tools.catalog_url": "An optional remote tools catalog (an https URL of its index). Empty means only the bundled catalog.",
  "tools.allow_vulners": "Allows vuln_scan's cve profile, which sends service names and versions to vulners.com. Off by default.",
  "monitoring.quiet_until": "Maintenance mode: until this time, monitors keep checking but raise no incidents. Set from Home Assistant.",
  "homeassistant.allow_resume": "Whether the Home Assistant integration may resume paused agents (pausing is always allowed).",
  "moss.announced_version": "The newest version Moss has announced in #general (What's new, from library/docs/changelog.md).",
} satisfies Record<SettingKey, string>;
