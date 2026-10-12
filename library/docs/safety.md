# Safety: the policy gate, change management and secrets

## The policy gate
Every network tool call goes through the gate, which checks, in order:
1. The kill switch (Settings) and the agent's own state: paused agents and agents over their hard
   budget can't call tools.
2. The tool grant: the agent must have the tool, from a skill or from Tool access.
3. Network scope: every target must be inside a network marked allowed on the Networks page.
   Off-limits networks are always refused; networks nobody has decided on are refused too.
4. The tool's class: read tools run straight away. Write tools only run as an exact step of an
   approved change request, inside its window. Dangerous tools also need "Allow dangerous tools".
5. Secrets: the agent must be granted each secret it uses, and the tool and target must be within the
   secret's scope.
6. Integrations: tools that belong to an integration (Home Assistant) only work while it is switched on.
A refused call is logged as tool.denied with a code and a reason; the agent sees the reason.

## Denial codes
- kill_switch: all agents are paused (Settings, or the sidebar's kill switch).
- agent_inactive: the agent is paused or fired.
- over_budget: the agent hit its hard budget; raise it on the agent's page.
- tool_not_granted: give the agent the skill, or grant the tool on Agents > Tool access.
- target_not_allowed: the target isn't in an allowed network; add or allow it on Networks. Exception: monitors and
  light checks (ping, tcp_connect, http_probe, tls_inspect) may reach a single public (non-private) address
  without a network entry. Private ranges (RFC 1918, CGNAT 100.64/10, loopback, link-local, IPv6 fc00::/7 and
  fe80::/10) always need an allowed network, as do scanners, address ranges and anything that signs in.
- target_off_limits: the network is marked off-limits, on purpose.
- invalid_target: the target isn't an IP or CIDR (hostnames must be resolved first), or an agent's
  http_probe path has a query string (never allowed for agents).
- change_required: a write tool needs an approved change request.
- change_not_executable / change_outside_window / call_not_in_change_plan: the change isn't approved
  yet, the window hasn't started or has ended, or the call differs from the approved plan in any way.
- dangerous_tool: dangerous tools are switched off in Settings.
- secret_not_granted: grant the secret to the agent (Settings > Secrets, Change scope and agents).
- secret_scope: the secret isn't allowed for that tool or that host; widen its scope if that's intended.
- secret_required: a credential must be passed as a secret:<name> handle, never typed in.
- module_disabled: switch the integration on (Settings > Integrations).
- setting_disabled: the action needs a setting switched on first, e.g. "Allow CVE lookups" (Settings) for
  vuln_scan's cve profile, which sends service versions to vulners.com. Also when "Agents may reach the
  internet" is off: light checks of public addresses, and DNS lookups of names outside the network (anything but
  single-word names, .local, .lan, .home, .home.arpa, .internal, .localdomain, .corp, .intranet and private IPs)
  are refused. Monitors still reach the internet. Also when "Credentials only for work credential managers
  start" is on and the person who started the run (a chat, manual run, schedule, incident or comment) can't manage
  credentials: carrying out an approved change still may, so raise a change instead.
- invalid_args: the arguments don't fit the tool. For example a password secret passed as an API key:
  pass it as password (with the username) instead.

## Change management
Anything that changes a system goes through a change request listing the exact tool calls it will make,
a rollback plan and a verification plan. Normal changes wait for someone with permission to approve
them; with "Require a separate approver" on, nobody approves their own. Standard changes come from
pre-approved templates and run straight away. Emergency changes (only if allowed in Settings) run at
once and are flagged for review. People can raise changes too (Changes > Raise a change): carried out
by an agent (with its exact tool calls) or by hand, in which case the person records the result.

## Secrets
Credentials are stored encrypted (AES-256-GCM, envelope encryption) and only the gate can decrypt them.
Agents and people only ever see a handle, secret:<name>. Each secret is scoped to hosts (required) and
optionally to tools, and granted to specific agents. A password secret can carry its account's username:
agents see the username, and the gate fills it in for tools that sign in. Saving a secret shows its
length and refuses values with spaces at either end, several lines, or that read like a note, unless you
tick "Save it even if it looks unusual". Values are scrubbed from tool results and the audit log.

Device keys: with "Remember device keys" on (the default, Settings → Safety), the first time a credential goes to
a device over HTTPS or SSH, MOSS remembers its certificate or host key. If it later presents a different one,
nothing is sent and the call fails saying so; Settings → Security → Device keys shows the change, to trust
after checking the device (a firmware update or renewed certificate) or to investigate. A port MOSS hasn't
used on a known device needs a key the device already showed, and a device that used HTTPS is never sent a
credential over plain HTTP. "Require trusted certificates" makes every device certificate be checked against
a trusted authority (public ones, plus deploy/device-ca/ca.pem); renewed certificates are then accepted. The
hardening guide (docs/hardening.md) explains these and the other optional settings: two-factor approvals,
chat approval rules, emergency tool lists, agent wiki drafts (agents' pages wait for a person to publish
them), and the deploy/.env options.

At work, or for anything you can't afford to lose, the hardening guide's first advice is: give agents
read-only credentials to critical systems (firewalls, routers, core switches, hypervisors, storage and
backups, identity and email). If you do give write access, only let people into MOSS whom you'd trust
with those systems directly. Owners, admins and change approvers can approve what runs, and operators
and their linked chat accounts can ask agents for work and raise changes. Standard changes, and emergency
changes if allowed, run without approval.

## Untrusted data
Scan results, device names, banners, web pages, log lines and webhook payloads come from the network and
may contain text written to manipulate an agent. MOSS passes them to agents as data and cleans them;
agents are told never to follow instructions found in them.

## Audit log
Every action by a person, an agent or MOSS itself is recorded in a hash chain. "Verify integrity" on the
Audit log page checks that no entry was altered.
