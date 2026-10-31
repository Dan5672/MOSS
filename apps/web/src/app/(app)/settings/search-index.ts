import { CHAT_NAMES, CHAT_PLATFORMS, INTEGRATIONS } from "@moss/core";
import type { SettingsEntry } from "./settings-search";
import { TOGGLES } from "./toggles";

/**
 * Everything the settings search finds. Sections link to their card's id on the page; add an entry here when a
 * settings card is added.
 */
export function settingsIndex(): SettingsEntry[] {
  const general = (label: string, id: string, words = ""): SettingsEntry => ({ label, where: "General", href: `/settings#${id}`, words });
  return [
    general("Telegram, Discord and Slack on your phone", "chat-apps", "chat notifications connect link mobile"),
    general("Display", "display", "motion animation reduced setup checklist"),
    general("Safety", "safety", "kill switch protections"),
    ...TOGGLES.map((t) => general(t.title, "safety", `safety ${t.description}`)),
    general("Time zone", "time-zone", "timezone utc clock local time"),
    general("Approval rules", "approvals", "approve changes chat emergency tools"),
    general("Two-factor authentication", "two-factor", "2fa totp authenticator code mfa"),
    general("HTTPS", "https", "certificate tls ssl ca addresses hostname trust"),
    general("Sign-in accounts", "sign-in-accounts", "sso single sign-on google microsoft link"),
    { label: "Change your password", where: "Security", href: "/settings/security#password" },
    { label: "Password policy", where: "Security", href: "/settings/security#policy", words: "length rules strength" },
    { label: "Device keys", where: "Security", href: "/settings/security#device-keys", words: "ssh host key fingerprint ports" },
    { label: "Secrets for tools", where: "Secrets", href: "/settings/secrets", words: "passwords credentials api keys tokens" },
    { label: "Model provider keys", where: "Secrets", href: "/settings/secrets", words: "anthropic openai openrouter api key llm" },
    { label: "MOSS backups", where: "Backups", href: "/settings/backups", words: "backup restore schedule download archive" },
    { label: "Device config backups", where: "Backups", href: "/settings/backups", words: "router switch firewall config" },
    { label: "Integrations", where: "Integrations", href: "/settings/integrations" },
    { label: "Home Assistant", where: "Integrations", href: "/settings/integrations/home-assistant", words: "ha smart home sensors self-heal plug" },
    ...CHAT_PLATFORMS.map((p) => ({ label: CHAT_NAMES[p], where: "Integrations", href: `/settings/integrations/${p}`, words: "chat bot notifications" })),
    { label: "Device logs (syslog)", where: "Monitoring → Logs", href: "/monitoring/logs", words: "syslog collector vector accepted senders" },
    ...INTEGRATIONS.map((d) => ({ label: d.name, where: "Integrations", href: `/settings/integrations/${d.key}`, words: d.description })),
    { label: "Networks", where: "Networks", href: "/networks", words: "allowed off-limits cidr subnet scan" },
    { label: "Users and roles", where: "Users", href: "/users", words: "people invite permissions roles" },
    { label: "Version and updates", where: "About", href: "/settings/about", words: "upgrade release what's new" },
    { label: "Licence", where: "About", href: "/settings/about", words: "license business plan key" },
  ];
}
