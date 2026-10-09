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
6. Modules: tools that belong to a module (Home Assistant) only work while the module is on.
A refused call is logged as tool.denied with a code and a reason; the agent sees the reason.

## Denial codes
- kill_switch: all agents are paused (Settings, or the sidebar's kill switch).
- agent_inactive: the agent is paused or fired.
- over_budget: the agent hit its hard budget; raise it on the agent's page.
- tool_not_granted: give the agent the skill, or grant the tool on Agents > Tool access.
- target_not_allowed: the target isn't in an allowed network; add or allow it on Networks.
- target_off_limits: the network is marked off-limits, on purpose.
- invalid_target: the target isn't an IP or CIDR (hostnames must be resolved first).
- change_required: a write tool needs an approved change request.
- change_not_executable / change_outside_window / call_not_in_change_plan: the change isn't approved
  yet, the window hasn't started or has ended, or the call differs from the approved plan in any way.
- dangerous_tool: dangerous tools are switched off in Settings.
- secret_not_granted: grant the secret to the agent (Settings > Secrets, Change scope and agents).
- secret_scope: the secret isn't allowed for that tool or that host; widen its scope if that's intended.
- secret_required: a credential must be passed as a secret:<name> handle, never typed in.
- module_disabled: switch the module on (Settings > Modules).
- setting_disabled: the action needs a setting switched on first, e.g. "Allow CVE lookups" (Settings) for
  vuln_scan's cve profile, which sends service versions to vulners.com.
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

## Untrusted data
Scan results, device names, banners, web pages, log lines and webhook payloads come from the network and
may contain text written to manipulate an agent. MOSS passes them to agents as data and cleans them;
agents are told never to follow instructions found in them.

## Audit log
Every action by a person, an agent or MOSS itself is recorded in a hash chain. "Verify integrity" on the
Audit log page checks that no entry was altered.
