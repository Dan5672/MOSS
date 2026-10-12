import { settings, type Database } from "@moss/db";
import { and, eq } from "drizzle-orm";

export const SETTING_DEFAULTS = {
  "agents.kill_switch": false,
  "tools.allow_dangerous": false,
  "changes.allow_emergency": false,
  "changes.require_separate_approver": false,
  /** Hours an approved change without its own window may run, from its approval. */
  "changes.window_hours": 24,
  "monitoring.retention_days": 14,
  /** A remote tools catalog (https URL of its index); empty for the bundled catalog only. */
  "tools.catalog_url": "" as string,
  /** vuln_scan's "cve" profile sends service names and versions to vulners.com, so it is off until allowed. */
  "tools.allow_vulners": false,
  /** Whether agents may reach the internet (public addresses and DNS names outside the LAN). See docs/hardening.md. */
  "agents.allow_internet": true,
  /** Device tools always verify TLS certificates; agents can't turn it off. Off by default: most home lab devices are self-signed. */
  "tools.verify_tls": false,
  /** Remember each device's certificate or SSH host key the first time a credential goes to it, and refuse a different one later. */
  "tools.pin_hosts": true,
  /** Which changes the chat apps' Approve button may approve: "standard" (anything but high risk), "low_risk", or "off". */
  "changes.chat_approvals": "standard" as "standard" | "low_risk" | "off",
  /** Approving a change asks for the approver's two-factor code (and so can't be done from a chat app). */
  "changes.approval_totp": false,
  /** The only tools an emergency change may use; empty means any. */
  "changes.emergency_tools": [] as string[],
  /** What agents write to the wiki is a draft that other agents don't see until a person publishes it. */
  "knowledge.agent_drafts": false,
  /** Agent work a person started may only use credentials if that person can manage credentials. */
  "agents.credentials_need_manager": false,
  /** The password policy's two-factor requirement applies to people who sign in with Microsoft or Google too. */
  "auth.sso_require_totp": false,
  /** Until when (ISO time) monitors stay quiet: no new incidents. Set from Home Assistant's maintenance mode. */
  "monitoring.quiet_until": "" as string,
  /** Whether Home Assistant may resume agents (pausing them is always allowed). */
  "homeassistant.allow_resume": false,
  /** The newest changelog version Moss has announced in #general. */
  "moss.announced_version": "" as string,
  /** Only owners may sign in with a password; everyone else signs in with Microsoft or Google. */
  "auth.sso_only": false,
  /** The business licence key (signed, checked on every use; see licensing/licence.ts). Empty: none. */
  "licence.key": "" as string,
  /** Which licence expiry reminders have been sent, for which licence. */
  "licence.reminded": {} as Record<string, unknown>,
  /** The last "Check for updates" (Settings → About): when, the newest release and how this install compares. */
  "moss.update_check": {} as Record<string, unknown>,
  /** The password policy (see auth/password-policy.ts); empty means the defaults. */
  "auth.password_policy": {} as Record<string, unknown>,
  /** The certificate uploaded in Settings → HTTPS (subject, expiry, fingerprint, reminders sent); empty when MOSS's own CA is in use. */
  "https.certificate": {} as Record<string, unknown>,
  /** Scheduled MOSS backups (see services/moss-backups.ts); empty means off. */
  "backups.schedule": {} as Record<string, unknown>,
  /** When the last scheduled MOSS backup was started (ISO time), or when the schedule was saved. */
  "backups.last_scheduled": "" as string,
  /** The UPS shutdown plan (integrations/ups-shutdown.ts); empty means off. */
  "ups.shutdown_plan": {} as Record<string, unknown>,
  /** The shutdown in progress, if any (its change). */
  "ups.shutdown_run": {} as Record<string, unknown>,
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
  "changes.window_hours": "How many hours after its approval a change without a window of its own may be carried out (24 by default). After that it has to be raised again.",
  "monitoring.retention_days": "How many days of individual monitor check results are kept. Graphs go further back from rollups: 5-minute ones for 90 days and hourly ones for 2 years.",
  "tools.catalog_url": "An optional remote tools catalog (an https URL of its index). Empty means only the bundled catalog.",
  "tools.allow_vulners": "Allows vuln_scan's cve profile, which sends service names and versions to vulners.com. Off by default.",
  "agents.allow_internet":
    "Whether agents may reach the internet: ping, TCP, HTTP and TLS checks of public addresses, and DNS lookups of names outside your network. On by default. Turn it off so an agent tricked by something it read can't send data out. Monitors aren't affected.",
  "tools.verify_tls":
    "Makes device tools always check TLS certificates, so a credential only goes to a device with a trusted certificate. Off by default because most home lab devices use self-signed certificates.",
  "changes.chat_approvals":
    "Which changes the Approve button in Telegram, Discord and Slack may approve: anything but high risk (the default), low risk only, or none (approve in MOSS). Emergency changes, access requests and dangerous tools are always approved in MOSS.",
  "changes.approval_totp":
    "Asks for the approver's two-factor code to approve a change, so a stolen session or chat account can't approve. Chat apps can't ask for a code, so their Approve button goes away. Off by default.",
  "changes.emergency_tools":
    "The only tools an emergency change may use, when emergency changes are allowed. Empty means any tool.",
  "knowledge.agent_drafts":
    "Makes what agents write in the wiki a draft: other agents don't see it until a person reads it and publishes it, so a note an agent was tricked into writing can't mislead the rest. Off by default.",
  "agents.credentials_need_manager":
    "Agent work a person started (a chat, a manual run, a schedule they set) may only use stored credentials if that person can manage credentials. Stops someone with a smaller role using an agent to reach devices they couldn't. Off by default.",
  "auth.sso_require_totp":
    "Applies the password policy's two-factor requirement to people who sign in with Microsoft or Google too: they set up a MOSS code and enter it after signing in. Off by default: then only people who already have a MOSS code are asked for it, and everyone else is trusted on the provider's own checks.",
  "tools.pin_hosts":
    "Remembers each device's certificate or SSH host key the first time MOSS sends it a credential, and refuses to send credentials if it changes. On by default; a changed key is shown in Settings, Security to trust or investigate.",
  "monitoring.quiet_until": "Maintenance mode: until this time, monitors keep checking but raise no incidents. Set from Home Assistant.",
  "homeassistant.allow_resume": "Whether the Home Assistant integration may resume paused agents (pausing is always allowed).",
  "moss.announced_version": "The newest version Moss has announced in #general (What's new, from library/docs/changelog.md).",
  "auth.sso_only": "Single sign-on only: everyone but owners must sign in with Microsoft or Google (owners keep their password and two-factor, in case sign-in breaks).",
  "licence.key":
    "The business licence (Settings → About): a signed key, checked offline. Business integrations work only while it's valid, or for 14 days after it expires.",
  "licence.reminded": "Which reminders about the business licence's expiry have been sent (30 and 7 days before, on expiry, and when it stops).",
  "moss.update_check": "The last check for MOSS updates (Settings → About): when it ran, the newest release on GitHub, and whether this install is up to date.",
  "auth.password_policy":
    "The password policy (Settings → Security): minimum length (12 by default), required kinds of character, how many old passwords can't be reused, maximum age, who must use two-factor sign-in, and an optional check against known-breached passwords.",
  "https.certificate":
    "The certificate uploaded in Settings → HTTPS, if any: who it's for, when it expires and its fingerprint. Moss reminds everyone in #general 30 and 7 days before it runs out. Empty when MOSS uses its own certificate authority.",
  "backups.schedule":
    "Scheduled MOSS backups (Settings → Backups): off, daily or weekly at an hour in the install's time zone, and how many archives to keep (10 by default). Archives go to deploy/backups on the host, the same as deploy/backup.sh makes.",
  "backups.last_scheduled": "When the last scheduled MOSS backup started (or the schedule was saved), so each slot runs once.",
  "ups.shutdown_plan":
    "The UPS shutdown plan (Settings > Integrations > UPS): what to switch off, in order, when a UPS on battery runs low; who carries it out; and whether it asks for approval each time or was approved in advance with a two-factor code.",
  "ups.shutdown_run": "The shutdown MOSS raised in the current power cut, so it isn't raised twice and can be cancelled if the power comes back.",
} satisfies Record<SettingKey, string>;
