# Hardening MOSS

MOSS's defaults suit a typical home lab: they protect you without breaking the self-signed devices, chat
approvals and "is the internet down?" questions most homes rely on. A business, a school or any network
other people depend on needs more, and accepts more friction for it. This guide walks through every
optional setting: what it protects against, what it costs, and what we recommend for a **home lab** and for
a **work** environment. Choose per setting; nothing here is all or nothing.

MOSS's own safety rules (the policy gate, change approval, scoped secrets) are always on. Read
[How MOSS keeps you safe](getting-started.md#6-how-moss-keeps-you-safe) first. This guide builds on it.

Most options are in **Settings** (the Safety and Approval rules cards). A few are in `deploy/.env`, because
they protect you even if the web app itself were taken over. After changing `deploy/.env`, restart MOSS:
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`.

## At work: start read-only

If MOSS looks after a business, or anything you can't afford to lose, two rules matter more than any
setting in this guide.

**1. Give agents read-only credentials to your critical systems.** These are the systems whose failure
stops work or exposes data: firewalls and routers, core switches, hypervisors, storage and backups, and
identity and email (Microsoft 365, Google Workspace, cloud accounts). With read-only credentials, agents
can still find problems, explain them and propose the fix. You make the change yourself. However an agent
is misled or MOSS is set up, a read-only account can't break the system.

**2. If you do give write access, only let people into MOSS whom you'd trust with that system directly.**
Once MOSS holds a credential that can change a system, anyone who can get an agent to use it has a route
to that system:

- **Owners and admins** manage credentials, agents and approval rules, and can approve any change.
- **Change approvers** decide what runs.
- **Operators**, and chat accounts linked to them, can ask agents for work and raise changes. Standard
  changes run without approval, and emergency changes too if you allow them.

So treat access to MOSS as access to every system it can change:

- Keep MOSS to staff who are already allowed to administer those systems. Remove anyone who leaves or
  changes role, and check **Settings, Users** and linked chat accounts regularly.
- Require two-factor sign-in for everyone (step 9) and a two-factor code to approve (step 5).
- Turn on **Require a separate approver** (step 5) and **Credentials only for work credential managers
  start** (step 8).
- Keep emergency changes off (step 6), and don't make standard changes for critical systems.
- Limit each write credential to one device and the tools that need it (step 4).

## Checklist

**In MOSS**

| Step | Where | Default | Home lab | Work |
| --- | --- | --- | --- | --- |
| [1. Keep agents off the internet](#1-keep-agents-off-the-internet) | Settings, Safety | Agents may reach it | Your choice | Off |
| [2. Remember device keys](#2-remember-device-keys) | Settings, Safety | On | On | On |
| [3. Require trusted certificates](#3-require-trusted-certificates) | Settings, Safety | Off | Off | On, with your own certificate authority |
| [4. Narrow every credential](#4-narrow-every-credential) | Settings, Secrets | As you set them | One device per secret | One device, one tool, read-only account, HTTPS |
| [5. Tighten approvals](#5-tighten-approvals) | Settings, Safety and Approval rules | Chat approves anything but high risk | Default | Two-factor code to approve; chat low risk only, or off |
| [6. Limit emergency changes](#6-limit-emergency-changes) | Settings, Safety and Approval rules | Off | Off | Off, or a short tool list |
| [7. Review what agents write](#7-review-what-agents-write) | Settings, Safety | Agents publish wiki pages | Your choice | Agents write drafts |
| [8. Keep credentials for the right people](#8-keep-credentials-for-the-right-people) | Settings, Safety | Off | Off | On |
| [9. Lock down sign-in](#9-lock-down-sign-in) | Settings, Security and Safety | Two-factor optional | Two-factor for admins | Two-factor for everyone, Microsoft and Google sign-in included |
| [10. Decide every network](#10-decide-every-network) | Networks | Undecided networks are refused | Decide yours | Everything you don't manage is off limits |
| [11. Choose where your data goes](#11-choose-where-your-data-goes) | Agents, Models | Your choice | Your choice | A local model, or a provider your organisation has approved |

**In `deploy/.env`**

| Step | Setting | Default | Home lab | Work |
| --- | --- | --- | --- | --- |
| [12. Keep backups on the host](#12-keep-backups-on-the-host) | `MOSS_BACKUP_DOWNLOADS` | `true` | `true` | `false` |
| [13. Fence in the toolbox](#13-fence-in-the-toolbox) | `MOSS_TOOLBOX_INTERNET` | `true` | `true` | `false`, unless you use cloud integrations or Microsoft or Google sign-in |
| [14. Fix MOSS's address](#14-fix-mosss-address) | `MOSS_PUBLIC_URL` | Taken from each request | Optional | Set it, if you use Microsoft or Google sign-in |
| [15. Keep MOSS itself private](#15-keep-moss-itself-private) | Your network | Not exposed | Tailscale from away | VPN only, on a machine used for nothing else |
| [16. Protect backups and upgrades](#16-protect-backups-and-upgrades) | `deploy/` | Release tags are checked | Archives off the machine | Encrypted archives off the machine; signed release tags only |

**Turning a Safety switch off, or loosening the Approval rules, asks for your two-factor code**, so a
stolen session can't quietly undo them. Set up two-factor sign-in before you harden. Other admin pages
(people and roles, the password policy, single sign-on, device keys, networks and secrets) don't ask for a
code yet, so an owner's or admin's session is still worth protecting: two-factor for everyone (step 9),
and few owners and admins.

## 1. Keep agents off the internet

**Settings, Safety: turn off "Agents may reach the internet".**

**Why.** An agent reads things an attacker can write: a device's name, a web page title, a log line, a
webhook. A message hidden in them ("prompt injection") might talk an agent into sending what it knows
out of your network, for example by probing `203.0.113.9` or looking up `your-data.attacker.example`.
Neither needs a password, and neither changes anything, so no approval is asked for. With this setting
off, the gate refuses both:

- ping, TCP, HTTP and TLS checks of public addresses;
- DNS lookups of names outside your network. Single-word names (`nas`), names ending in `.local`,
  `.lan`, `.home`, `.home.arpa`, `.internal`, `.localdomain`, `.corp` or `.intranet`, and private IP
  addresses still work.

Whatever this setting says, an agent's HTTP check can't carry a query string (`?...`), because that is
how a "look" turns into a "do" on many devices.

**What it costs.** Agents can't check your internet connection or a public website themselves. Use
**monitors** for that: they're run by MOSS, not by an agent, so they keep working, and an agent still
investigates when one goes down. Names under your own domain (for example `nas.example.com` on split DNS)
count as internet names; use the device's IP address instead.

**What it doesn't stop.** A device an attacker controls *inside* an allowed network can still receive
data, for example in the path of an HTTP check sent to it. Decide every network (step 10), and fence in
the toolbox (step 13) for a second wall.

## 2. Remember device keys

**Settings, Safety: keep "Remember device keys" on.** It's on by default.

**Why.** MOSS sends a credential to whatever answers at the address you gave. If something else takes
that address (a device you don't know about, a replaced device, or someone spoofing it on your network),
it would receive the password. So the first time MOSS sends a device a credential over HTTPS or SSH, it
remembers the device's TLS certificate or SSH host key. Later, before sending anything:

- a different certificate or key on the same port stops the call;
- a port MOSS hasn't used on that device only passes with a key the device already showed on another port;
- a device that has used HTTPS with MOSS is never sent a credential over plain HTTP.

This covers agents' tools, integrations and monitors that sign in. Different spellings of an address
(such as `::ffff:192.168.1.5`) count as the same device.

**When a key changes.** **Settings, Security, Device keys** lists every remembered key, with changed and
new ones first. A device's key changes for ordinary reasons: a firmware update, a renewed certificate, a
factory reset or a replacement. Check it on the device itself before you choose **Trust new key**:

- a web interface usually shows its certificate's SHA-256 fingerprint;
- on a server, `for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done` lists every host key
  (the device may present any of them).

MOSS trusts exactly the key you were shown: if the device presents yet another one while you're checking,
nothing is trusted and you're asked to look again. If you can't explain a change, don't trust it: find
out what is answering at that address first.

**Make the first use count.** The first key is trusted as presented. Check it once in the Device keys
list after you first connect a device.

**What it can't protect.** Credentials sent over plain text: HTTP to a device that has never used HTTPS
with MOSS, SNMP communities and NUT (UPS) passwords. Use HTTPS wherever the device offers it (step 4),
and keep SNMP communities read-only.

## 3. Require trusted certificates

**Settings, Safety: turn on "Require trusted certificates"** once your devices have certificates that
MOSS can check.

**Why.** Remembering keys (step 2) protects you after the first use. A certificate signed by an
authority you trust protects you from the first use too, and a renewed certificate is accepted without
you trusting it by hand (the Device keys list just updates).

**What it needs.** MOSS connects to devices by IP address, so each device's certificate must:

- include the device's IP address (not only a name), and
- be signed by an authority MOSS trusts. That's the public authorities, plus your own: put its
  certificate (never its key) in `deploy/device-ca/ca.pem` and restart MOSS. MOSS trusts your authority
  only for your devices, not for its cloud or sign-in traffic. (Public authorities stay trusted for
  devices too, but they don't issue certificates for private addresses.)

With this on, a device certificate your authority signed is trusted even when it replaces a remembered one
(that's how renewals pass). So guard that authority's key: whoever holds it can stand in for any device.

Public authorities such as Let's Encrypt don't issue certificates for private addresses, so in practice
this means running your own small certificate authority (for example step-ca) for your devices.

**What it costs.** Most home lab devices (UniFi, Proxmox, TrueNAS, Synology, firewalls) ship with
self-signed certificates. With this setting on, MOSS refuses to send them credentials until they have
certificates as above. Turn it on when that's done, not before.

## 4. Narrow every credential

**Settings, Secrets** (or **Assets, Agent access**, which does this for you).

- **Read-only accounts.** Make a separate account for MOSS on each device, with only the rights it needs.
  Most products (UniFi, Proxmox, TrueNAS, Home Assistant, Pi-hole) have a viewer role. You can then see
  what MOSS did on the device itself, and switch it off in one place. At work, make it read-only for
  every critical system ([At work: start read-only](#at-work-start-read-only)).
- **One device per secret.** Limit each secret to the single address it belongs to (`192.168.1.10`, not
  `192.168.1.0/24`). Then a credential can only ever go to that address.
- **One tool per secret,** where you can, so a credential stored for status checks can't be passed to a
  tool that changes things.
- **HTTPS where the device offers it.** Set integrations to HTTPS, and connect each device over HTTPS
  once: from then on MOSS won't send it a credential over plain HTTP (step 2). Some tools (Home Assistant,
  Pi-hole, AdGuard, config backups) default to HTTP.
- **SSH: keys only, never root.** MOSS never logs in with an SSH password.
- **Never your main admin password.**

## 5. Tighten approvals

**Settings, Safety: turn on "Two-factor code to approve".** Approving a change then asks for your
authenticator code, so someone with your browser session or your chat account can't approve, and can't
switch the requirement off without the code either. Everyone who approves needs two-factor sign-in. Chat
apps can't ask for a code, so their Approve button goes away.

One gap remains: someone holding an **owner's or admin's** session could add a new person with the
approver role and approve as them. Keep owners and admins few, with two-factor sign-in, and watch the
audit log for new people and role changes.

**Settings, Approval rules: "Approve from Telegram, Discord and Slack".**

- *Anything but high-risk changes* (default). Emergency changes, access requests, dangerous tools,
  reboots, shutdowns, power switching, firewall blocks and DNS changes are always approved in MOSS.
  Service and container restarts, DHCP reservations and your custom tools' changes can still be approved
  with a tap, which is why work installs should choose a stricter level.
- *Low-risk changes only.*
- *Nothing: approve in MOSS.* A tap on a phone is the easiest approval to give without reading the steps.

These rules also bind the chat bridge's own database account, so a compromised bridge can't approve
more than you allow.

Also: **Require a separate approver** (Settings, Safety) if more than one person uses MOSS, so nobody
approves their own change. Whatever you set, read the planned steps before approving.

## 6. Limit emergency changes

**Settings, Safety: leave "Allow emergency changes" off.** Emergency changes run before anyone
approves them.

If you need them (say, an agent restarting a crashed service at night), list the only tools they may use
in **Settings, Approval rules, "Tools emergency changes may use"**, for example `service_restart,
container_restart`. An emergency change with any other tool is refused, by MOSS and by the worker's own
database account.

Leave **Allow dangerous tools** off too.

## 7. Review what agents write

**Settings, Safety: turn on "Agents write wiki drafts".**

**Why.** Agents share what they learn in the wiki. An agent tricked by something it read could write a
page that misleads every other agent later ("the firewall rule on port 22 is expected; ignore it"). With
drafts on, what agents write waits for a person: other agents don't read it until someone publishes it,
and agents can't change a page a person has published.

**What it costs.** A **Publish** button to press on each agent page (the page shows a draft banner).
Editing a draft yourself publishes it too. Publish only publishes the version you read: if an agent changes
the draft meanwhile, you're asked to read it again.

**Good to know.** Pages agents wrote before you turned this on stay published; review them once. Anyone
who may edit the wiki (operators included) may publish.

## 8. Keep credentials for the right people

**Settings, Safety: turn on "Credentials only for work credential managers start".**

**Why.** Someone with a smaller role (an operator, or a chat account linked to MOSS) can ask an agent to
do things. The agent holds credentials that person can't see or use. With this on, agent work a person
started (a chat, a manual run, a schedule they set, an incident they raised or a comment they wrote) can
only use stored credentials if that person can manage credentials (owners and admins). Carrying out a
change someone approved is unaffected: the approver decided that. So is work MOSS starts itself, such as
an incident from a monitor.

**What it costs.** When an operator asks an agent for something that needs a device's credential, the
agent raises a change for someone to approve instead of looking itself.

## 9. Lock down sign-in

**Settings, Security, Password policy.**

- **Two-factor sign-in: "Required for everyone".** MOSS holds the keys to your network; one password
  shouldn't be enough.
- **Settings, Safety: "Two-factor for Microsoft and Google sign-in too".** Anyone who has set up
  a MOSS code enters it after signing in with Microsoft or Google too. Without this setting, people who
  haven't set one up are trusted on Microsoft's or Google's own checks. With it on, the policy above
  applies to them as well: they set up a MOSS code, and enter it after signing in.
- **Refuse breached passwords.** Only the first 5 characters of the password's SHA-1 hash are sent to
  Have I Been Pwned, never the password.
- **Single sign-on only** (Settings, Integrations, the Microsoft or Google sign-in card), if your
  household or team already has those accounts. Owners keep their password, in case sign-in breaks.
- **Roles.** Give people the smallest role that works: **viewer** to look, **operator** to work
  incidents, **change approver** to approve. Keep owners and admins to one or two people. If agents hold
  write credentials, anyone who can ask an agent for work or approve a change has a route to those systems
  ([At work: start read-only](#at-work-start-read-only)).

## 10. Decide every network

**Networks.** MOSS refuses any network nobody has decided on. Mark the networks you manage **allowed**,
and everything else you know about **off limits**: work equipment, a neighbour's or landlord's network,
your ISP's gear, guest Wi-Fi. Off limits always wins, even inside an allowed range. Scanning networks you
don't own or administer may be illegal where you live.

## 11. Choose where your data goes

**Agents, Models.** With a hosted model (Anthropic, OpenAI and others), what an agent reads goes to that
provider: device names, addresses, logs and your messages. Stored credentials aren't sent, and MOSS
removes them from anything a device echoes back before an agent sees it, though that scrubbing only
catches the forms it knows (plain, Base64, hex). A local model
(Ollama) keeps that at home. With step 1 as well, agents can't send it to the internet themselves.

Some features send data out by design, and you choose them: chat apps (Telegram, Discord, Slack),
PagerDuty, cloud integrations, CVE lookups and update checks.

## 12. Keep backups on the host

**`deploy/.env`: `MOSS_BACKUP_DOWNLOADS=false`.**

**Why.** A backup includes the master key, which unlocks every stored credential. Normally you can
download one (encrypted with a passphrase you choose) from Settings, Backups. With this set to `false`,
the backup service refuses downloads to anyone, so even someone who took over the web app can't get an
archive out. You copy backups from `deploy/backups` on the host instead.

**What it costs.** No download button. Backups still run, on schedule or with **Back up now**.

**Good to know.** The web app can still delete backups, so also copy them off the machine (step 16).

## 13. Fence in the toolbox

**`deploy/.env`: `MOSS_TOOLBOX_INTERNET=false`.**

**Why.** The toolbox is the part of MOSS that talks to your devices. With this set, it can only reach
private addresses: a firewall inside its container, set before it starts and out of its own reach, refuses
the internet. It backs up step 1 at the network level.

**What it costs.** Everything the toolbox does on the internet stops: cloud integrations (AWS, Microsoft
365, Google Workspace, Cloudflare, Tailscale, PagerDuty, Meraki), **sign-in with Microsoft or Google**,
monitors of internet addresses, CVE lookups and update checks. Use it if your MOSS only looks after your
own network.

**What it doesn't stop.** It's a fence, not a vault. Name lookups still reach the internet through your DNS
resolver, and the network scanner can send raw packets the firewall doesn't see. If the toolbox itself
were taken over, those are ways out. On a work network, also block MOSS's host from the internet at your
own firewall, apart from what you use.

## 14. Fix MOSS's address

**`deploy/.env`: `MOSS_PUBLIC_URL=https://moss.lan`** (several, separated by commas, for example
`https://moss.lan,https://moss.tail1234.ts.net`).

**Why.** Sign-in with Microsoft or Google sends you back to MOSS at an address MOSS works out from the
request. With this set, only your addresses are used, whatever a request claims.

**What it costs.** It's read from `deploy/.env` only. When MOSS's address changes (for example in
Settings, HTTPS, Change addresses), update it there too and restart MOSS, or Microsoft and Google sign-in
will send people back to the old address.

## 15. Keep MOSS itself private

- **Never forward a port to MOSS.** Use Tailscale to reach it from away
  ([Getting started](getting-started.md)).
- **Trust MOSS's certificate on each device** (Settings, HTTPS), so your browser can warn you if something
  else ever answers at MOSS's address.
- **Leave the development ports closed.** `deploy/docker-compose.dev.yml` publishes the database and the
  gate on this computer for development. Don't use it on a machine you run MOSS on for real.
- **Keep `deploy/secrets/` and `deploy/.env` private.** `init.sh` makes `.env` readable by you only;
  keep it that way.

## 16. Protect backups and upgrades

- **Keep archives off the machine,** somewhere only you can read, and encrypted (an encrypted drive or an
  encrypted cloud folder). Downloads from Settings are encrypted with your passphrase; use a long one.
- **Only restore backups you made.** A restore trusts the archive completely.
- **Upgrade to release tags.** `deploy/upgrade.sh <tag>` refuses a release tag that isn't signed by a key
  you trust (`git verify-tag`). It can't check a branch or a commit, which is what it upgrades to when no
  release tag exists, so prefer tags and pass `--allow-unsigned` only when you know why.
- **Keep MOSS updated.** Settings, About checks for new releases.
- **Check what you're running.** Each release on GitHub has a software bill of materials (SPDX and CycloneDX)
  listing every package at its exact version, for your vulnerability scanner. It's signed by GitHub for this
  repository: `gh attestation verify moss-<tag>-source.tar.gz --repo Dan5672/MOSS --predicate-type https://spdx.dev/Document/v2.3`.

## What hardening doesn't cover

- **An agent can still be misled into proposing something harmful.** Your approval is the last line of
  defence: read the steps, check the target, reject anything you don't understand.
- **The kill switch stops agents, not a call already running on a device.** MOSS stops waiting for it and
  nothing new starts, but a device may finish what it was asked.
- **Anyone who controls the machine MOSS runs on controls MOSS.** Keep that machine updated, and limit
  who can log in to it.
- **Plain-text protocols** (HTTP, SNMP, NUT) send credentials readable by anyone on the same network.
