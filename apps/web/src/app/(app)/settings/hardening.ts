// Which way each safety switch weakens MOSS. Weakening one asks for the person's two-factor code, so a stolen
// session can't switch protections off (for example the approval code) and then use what they protected.
import type { SettingKey } from "@moss/core";

export const WEAKENED_BY: Partial<Record<SettingKey, boolean>> = {
  "tools.allow_dangerous": true,
  "changes.allow_emergency": true,
  "changes.require_separate_approver": false,
  "tools.allow_vulners": true,
  "agents.allow_internet": true,
  "tools.pin_hosts": false,
  "tools.verify_tls": false,
  "changes.approval_totp": false,
  "knowledge.agent_drafts": false,
  "agents.credentials_need_manager": false,
  "auth.sso_require_totp": false,
};

export const weakens = (key: SettingKey, value: unknown) => key in WEAKENED_BY && WEAKENED_BY[key] === value;

const CHAT_LEVELS = ["off", "low_risk", "standard"];
/** Allowing more from chat, or more tools in emergency changes. */
export function rulesWeaken(before: { level: string; tools: string[] }, after: { level: string; tools: string[] }) {
  if (CHAT_LEVELS.indexOf(after.level) > CHAT_LEVELS.indexOf(before.level)) return true;
  if (before.tools.length > 0 && (after.tools.length === 0 || after.tools.some((t) => !before.tools.includes(t)))) return true;
  return false;
}
