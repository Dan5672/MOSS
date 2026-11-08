import type { SettingKey } from "@moss/core";

/** The on/off switches under Settings → Safety (also indexed by the settings search). */
export const TOGGLES: { key: SettingKey; title: string; description: string; danger?: boolean; permission: "killswitch.use" | "settings.manage" }[] = [
  {
    key: "agents.kill_switch",
    title: "Kill switch",
    description: "Stop every agent immediately. Running agents halt before their next step and nothing new starts.",
    danger: true,
    permission: "killswitch.use",
  },
  {
    key: "changes.allow_emergency",
    title: "Allow emergency changes",
    description: "Let agents make urgent changes without waiting for approval. Each one is flagged for review afterwards.",
    permission: "settings.manage",
  },
  {
    key: "changes.require_separate_approver",
    title: "Require a separate approver",
    description: "Nobody can approve a change they requested themselves.",
    permission: "settings.manage",
  },
  {
    key: "tools.allow_vulners",
    title: "Allow CVE lookups",
    description: "Let agents look up known vulnerabilities for the software versions they find (vuln_scan's cve profile). It sends service names and versions to vulners.com.",
    permission: "settings.manage",
  },
  {
    key: "agents.allow_internet",
    title: "Agents may reach the internet",
    description:
      "Lets agents check public addresses (ping, TCP, HTTP, TLS) and look up names outside your network. Turn it off so an agent misled by something it read can't send your data out. Monitors aren't affected.",
    permission: "settings.manage",
  },
  {
    key: "tools.pin_hosts",
    title: "Remember device keys",
    description:
      "The first time MOSS sends a device a credential, it remembers the device's certificate or SSH host key. If that changes, the credential isn't sent until you trust the new one in Settings, Security.",
    permission: "settings.manage",
  },
  {
    key: "tools.verify_tls",
    title: "Require trusted certificates",
    description:
      "Credentials only go to devices whose certificate is signed by a trusted authority and names the device's IP address. A renewed certificate is then accepted without asking. Leave it off if your devices use self-signed certificates.",
    permission: "settings.manage",
  },
  {
    key: "changes.approval_totp",
    title: "Two-factor code to approve",
    description: "Approving a change asks for the approver's two-factor code, so a stolen session or chat account can't approve. The chat apps' Approve button goes away.",
    permission: "settings.manage",
  },
  {
    key: "knowledge.agent_drafts",
    title: "Agents write wiki drafts",
    description: "What agents write in the wiki waits for a person to publish it before other agents read it, so a note one agent was tricked into writing can't mislead the rest.",
    permission: "settings.manage",
  },
  {
    key: "agents.credentials_need_manager",
    title: "Credentials only for work credential managers start",
    description:
      "Agent work someone started (a chat, a run, a schedule they set) may only use stored credentials if that person can manage credentials. Stops a smaller role reaching devices through an agent.",
    permission: "settings.manage",
  },
  {
    key: "auth.sso_require_totp",
    title: "Two-factor for Microsoft and Google sign-in too",
    description: "The password policy's two-factor rule applies to people who sign in with Microsoft or Google: they set up a MOSS code and enter it after signing in.",
    permission: "settings.manage",
  },
  {
    key: "tools.allow_dangerous",
    title: "Allow dangerous tools",
    description: "Permit tools marked dangerous (for example factory resets), still only through approved changes.",
    danger: true,
    permission: "settings.manage",
  },
];
