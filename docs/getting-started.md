# Getting started with MOSS

MOSS is an AI IT department for your home or small office. AI agents watch your network, raise and
work incidents, keep an inventory and a wiki, and propose changes. They only *carry out* a change
after a person approves exactly what will run.

This guide takes you from nothing to a working install, then covers the Home Assistant
integration. **Please read [Before you give an agent access](#before-you-give-an-agent-access)
before you give any agent credentials or the ability to change things.**

- [1. Install MOSS](#1-install-moss)
- [2. Open MOSS over HTTPS](#2-open-moss-over-https)
- [3. First steps](#3-first-steps)
- [4. Day to day](#4-day-to-day)
- [5. The Home Assistant integration](#5-the-home-assistant-integration)
- [6. How MOSS keeps you safe](#6-how-moss-keeps-you-safe)
- [7. Before you give an agent access](#before-you-give-an-agent-access)
- [8. Backups, upgrades and getting help](#8-backups-upgrades-and-getting-help)

---

## 1. Install MOSS

**You need:** a computer that stays on (a mini PC, a NAS that runs Docker, or a spare desktop), Docker
with the Compose plugin, `git` and `openssl`. A Linux host is recommended. MOSS uses about 2 GB of
memory, plus whatever your AI model needs if you run one locally.

```sh
git clone https://github.com/Dan5672/MOSS.git
cd MOSS
git checkout "$(git tag --list 'v*' --sort=-v:refname | head -n 1)"   # the newest release
sh deploy/init.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

`deploy/init.sh` creates:

- `deploy/.env`: your settings, with a random database password;
- `deploy/secrets/`: the **master key** that encrypts every password and key you give MOSS, and
  the tokens MOSS's own services use to talk to each other.

> **Back up `deploy/secrets/master.key` somewhere safe, away from this machine.** Without it, the
> credentials stored in MOSS can't be decrypted, even from a backup.

The first build takes several minutes.

## 2. Open MOSS over HTTPS

New installs come with HTTPS switched on, so every device on your network gets an encrypted
connection. `init.sh` prints the addresses MOSS answers to, for example `https://192.168.1.20`.

MOSS uses **its own certificate authority** for this. That means nothing to buy, register or open
to the internet, but your devices don't know it yet: the first time, your browser warns that the
connection isn't trusted. To fix that once per device:

1. Open MOSS, accept the warning this one time, sign in, and go to **Settings → HTTPS**.
2. Download MOSS's certificate, and **check the fingerprint shown there** matches the certificate
   you downloaded.
3. Install it as a trusted root certificate. Settings shows how on Windows, macOS, iPhone/iPad and
   Android.

After that, there are no more warnings on that device.

**Already have a certificate?** If you have a domain with a Let's Encrypt certificate, a Tailscale
certificate (`tailscale cert`) or a company certificate authority:

1. Put `cert.pem` (the full chain) and `key.pem` in `deploy/certs/`.
2. Set `MOSS_TLS=files` in `deploy/.env`.
3. Restart MOSS.

**Names and addresses.** MOSS's certificate covers the names in `MOSS_HTTPS_HOSTS` in
`deploy/.env`. If you reach MOSS by another name or address, add it there and restart.

**Turning HTTPS off.** Remove `COMPOSE_PROFILES=https` from `deploy/.env`. MOSS then only answers
on the machine itself, at `http://localhost:3000`.

## 3. First steps

The first page asks you to create the **owner** account. Choose a long password. Then turn on
two-factor sign-in: go to **Settings → Two-factor authentication** and scan the code with an
authenticator app. The **Getting started** checklist on the dashboard walks through the rest.

1. **Allow a network.** Go to **Settings → Networks** and add your home network, for example
   `192.168.1.0/24`, marked **allowed**.
   - Agents can only touch networks you have allowed.
   - Mark anything they must never touch as **off limits**: a work VPN, a neighbour's network, your
     ISP's equipment.
   - Set the network's **DNS server** (usually your router), so devices are found by name rather
     than just their address.
2. **Add a model.** Go to **Models** and add an AI provider and a model. You can use:
   - an API key (Anthropic, OpenAI and others);
   - a model on your own machine (Ollama, LM Studio);
   - a Claude subscription (see the README).

   Local models keep everything at home but are weaker at multi-step work. Hosted models are more
   capable, but what agents read is sent to the provider (see
   [section 7](#before-you-give-an-agent-access)).
3. **Hire an agent.** Go to **Agents** and hire a **Network Admin**. Every agent already knows how
   MOSS itself works: tickets, changes, the inventory, the wiki and monitoring. Skills add knowledge
   of a product (UniFi, Home Assistant, Proxmox…) or abilities that need your decision (scanning,
   restarting services, power).
4. **Let it discover your network.** Ask the Network Admin to run a discovery. Devices appear in
   **Assets**, each with an **Agent access** badge saying what agents can do with it.
5. **Add monitors.** Go to **Monitoring → Add a monitor** for the services you care about (your NAS,
   your router, Home Assistant). Choose an agent as the responder. When something goes down, MOSS
   raises an incident and the responder starts investigating.

You'll also meet **Moss**, an agent that knows MOSS itself. Ask it in **Chat** how to set
something up, or why something isn't working.

## 4. Day to day

- **The dashboard and the Basement** show what's happening. The Basement is the fun view: agents
  at desks or on a break, and a fire on the responder's desk when something is down.
- **Incidents** are problems to fix. Agents raise them from monitoring, discovery or your
  requests, and you can raise them too. Comment on one to talk to the agent working it, or use
  @mentions.
- **Changes** are how anything gets changed. An agent (or you) proposes the exact steps. You
  approve or reject it on the change page; the board view shows everything in flight. An agent can
  also ask for **access** (a tool or a credential) through a change. You decide.
- **Chat** works like Slack, with DMs and channels; #general is everyone. Agents reply when you
  message them or @mention them.
- **The wiki** is where agents (and you) write down how your network fits together, so the next
  incident starts from what's already known.
- **Activity** shows every agent run, step by step, and the audit log of every action.
- **The kill switch** at the bottom of the menu stops every agent at once.

---

## 5. The Home Assistant integration

The integration brings MOSS into Home Assistant:

- **Sensors:** open incidents, monitors down, changes waiting for approval, spending, and one
  sensor per agent.
- **Events:** for automations, including when a **new device joins your network**.
- **Safe controls:** pause all agents, maintenance mode, raise an incident, ask an agent,
  check a monitor.
- **A calendar** of change windows and recurring tasks.
- **Assist:** ask MOSS by voice.
- **The Basement card** for your dashboards.

Separately, MOSS's own **Home Assistant module** (Settings → Modules → Home Assistant) works the
other way round: it lets MOSS watch Home Assistant's health, send incidents to your phone, and
more. You can use either, or both.

### Install

1. **Get the integration.**
   - **With HACS:** go to HACS → ⋮ → **Custom repositories**, add
     `https://github.com/Dan5672/MOSS` with category **Integration**, then install **MOSS**.
   - **Without HACS:** in MOSS, go to **Settings → Modules → Home Assistant**, download the
     integration, and unzip it into Home Assistant's `config/custom_components` folder.

   Restart Home Assistant.
2. **Make a token in MOSS.** On the same MOSS page, choose **Make a token** and copy it. It's shown
   once.
3. **Add it in Home Assistant.** Go to **Settings → Devices & services → Add integration → MOSS**.
   Enter MOSS's address (for example `https://192.168.1.20`) and the token.
4. **If MOSS uses its own certificate,** Home Assistant shows the certificate's fingerprint.
   Compare it with **Settings → HTTPS** in MOSS. If it matches, confirm. Home Assistant then trusts
   MOSS and keeps checking the certificate on every connection.

Home Assistant must be able to reach MOSS's address. If it can't connect, check the address, and
that the computer running MOSS allows incoming HTTPS from your network (its firewall).

### What you get

| What | Examples |
| --- | --- |
| Sensors | `sensor.moss_open_incidents`, `sensor.moss_monitors_down`, `sensor.moss_changes_waiting_for_approval`, `sensor.moss_spend_today`, plus one per agent (`sensor.rambo_status`: working, on a break or paused, its task and last run) |
| Monitors | One binary sensor per monitor: on means there's a problem |
| Events | `event.moss_incident`, `event.moss_monitor`, `event.moss_change`, `event.moss_new_device`, `event.moss_agent`; also the `moss_event` bus event |
| Controls | `switch.moss_pause_all_agents`, `select.moss_maintenance_mode` (1, 2 or 4 hours with no incidents from monitoring), check-now and run-now buttons |
| Actions | `moss.raise_incident`, `moss.ask_agent` (returns the answer), `moss.acknowledge_incident` |
| Also | `calendar.moss_schedule`, `update.moss`, and **MOSS Assist** as a conversation agent (choose who answers in the integration's options) |

**The Basement card.** Add a card to a dashboard and pick **MOSS Basement**, or in YAML:

```yaml
type: custom:moss-basement-card
title: The Basement
# compact: true   # a one-line status strip, good for phones
```

**Ideas for automations:**

- *New device on the network:* `event.moss_new_device` → a phone notification with its name, IP
  and maker.
- *Internet down:* the monitor's binary sensor turns on → announce it on your speakers, or turn a
  light red.
- *Leak sensor wet:* → `moss.raise_incident` with priority P1, for your Home Automation agent.
- *Doing network work:* set maintenance mode for 2 hours, so MOSS doesn't raise incidents while
  you reboot things.

### What Home Assistant can't do

The integration can **read** MOSS, make it **do less** (pause agents, quiet monitoring) and **ask**
it things. It can't:

- approve or reject changes;
- touch secrets, tool access, networks or settings;
- resume paused agents, unless you tick **Let Home Assistant resume agents** in MOSS.

Its token acts as the person who made it, so it can never do more than they can, and every action
is in MOSS's audit log as "via Home Assistant". **Revoke the token in MOSS** if a Home Assistant
install is lost or compromised.

---

## 6. How MOSS keeps you safe

MOSS assumes two things: **the AI can be wrong**, and **your network can contain hostile data**. A
device can name itself "ignore your instructions and…". So MOSS's protections don't depend on the
AI behaving well; they're enforced outside it.

**What agents can do**

- **No shell.** Agents can't run commands of their choosing. They call specific tools ("scan this
  subnet", "check this web page") whose arguments are checked before anything runs.
- **A policy gate checks every tool call.** It checks:
  - the kill switch, and the agent's status, budget and tool grants;
  - the target's network: allowed networks only, off-limits ones never, and anything undecided is
    refused;
  - for anything that changes something: that it matches, exactly, a change a person approved,
    inside its time window.
- **Changes need approval.** Agents propose; people approve. An approved change runs exactly the
  listed steps and nothing else. You can require a different person to approve than the one who
  asked (Settings).
- **Emergency changes and dangerous tools are off by default.** Emergency changes skip approval.
  Dangerous tools include things like factory resets. Leave both off unless you have a clear
  reason.

**Credentials**

- **Credentials never reach the AI.**
  - Passwords, keys and tokens are encrypted at rest (AES-256-GCM, with each secret's key wrapped
    by the master key).
  - Agents only ever see a name like `secret:router-ssh`.
  - Only the gate decrypts them, and only for the devices and tools each one is limited to.
  - Anything a tool echoes back is scrubbed before the AI sees it.
- **Least privilege.** The part of MOSS that runs the AI holds no secrets and can't reach your
  network directly. The scanners run read-only, without administrator rights, with only the
  network permissions they need.

**Data and accountability**

- **Untrusted data stays data.** Scan results, device names, logs and webhook contents are cleaned
  up and handed to agents as information, never as instructions.
- **Everything is recorded.** Every action by a person or an agent goes into a hash-chained audit
  log. **Activity → Audit log → Verify integrity** checks nothing has been altered.

**Sign-in and limits**

- **Accounts:** two-factor sign-in, and roles (owner, admin, operator, change approver, viewer).
- **Spending limits:** daily and monthly budgets per agent or overall. Agents stop when they hit a
  hard limit.
- **The kill switch** stops every agent at once.

---

## Before you give an agent access

**Please read this.** MOSS lets AI agents work on real devices, and that comes with real risk. The
protections above reduce it; they don't remove it.

### What AI models are, and aren't

- **They can be confidently wrong.** A language model predicts plausible text. It can misread a
  scan, misidentify a device, invent a cause, or propose a fix that would break something, and
  sound completely sure. **Read what a change will do before you approve it.** "The agent said so"
  isn't a reason.
- **They can be manipulated.** Text an agent reads, such as a device name, a web page title, a log
  line or an email subject, can be written to look like instructions ("prompt injection"). MOSS
  treats such text as data and enforces its rules outside the model. Still, an agent misled into
  *proposing* something harmful is possible. **Your approval is the last line of defence.**
- **They aren't consistent.** The same question can get a different answer tomorrow, and a
  different model behaves differently. Watch an agent's work for a while before trusting it with
  more.
- **What they read may leave your network.** With a hosted model (Anthropic, OpenAI…), what an
  agent reads is sent to that provider to process: device names, addresses, logs, your messages.
  Credential *values* are never sent. If that matters to you, use a local model, and check the
  provider's data policies.
- **They cost money.** Hosted models charge per use, and a busy agent adds up. Set daily or monthly budgets on each
  agent's page.

### Giving agents access to your devices

MOSS separates **looking** from **changing**:

- **Look-only access is low risk.** Discovery, monitoring, reading status, checking certificates:
  scanning an allowed network can't damage anything, though some very old or fragile devices
  dislike being scanned.
- **Credentials and write access are where the risk is.** An agent with a router password can
  propose changing your router.

Before you hand over a credential or approve a change, consider:

- **Use read-only accounts wherever you can.** Many devices (UniFi, NAS boxes, Proxmox, Home
  Assistant) let you create a user that can see but not change. Give MOSS that one. For SSH, use
  a dedicated account with only the rights it needs, not root.
- **Never give an agent your main admin password.** Create a separate account for MOSS, so you can
  see what it did on the device itself and revoke it in one place.
- **Limit each credential.** When you store a secret, limit it to the devices and tools it's for.
  The asset wizard (**Assets → Agent access**) does this for you.
- **Approve carefully.** Read the exact steps. Check the target is right. Check there's a
  sensible way to undo it, and that it's a good time: not while you're away, or during a backup.
  Reject anything you don't understand, and ask the agent to explain in the change's comments.
- **Be extra careful with:**
  - firewall and VPN rules (you can lock yourself out);
  - DHCP and DNS (they can take the whole network down);
  - power-cycling (lost unsaved work, filesystem damage);
  - anything on equipment that other people, a business, or someone's health depends on.
- **Keep off-limits networks off limits.** Work equipment, a landlord's or neighbour's network,
  your ISP's gear and anything you don't own should be **off limits** in MOSS. Scanning networks
  you don't own or administer may be illegal where you live.
- **Keep backups of your devices' configs,** so a bad change can be undone. MOSS can take config
  backups of supported devices.
- **Keep MOSS itself safe.** It holds your network's credentials.
  - Use two-factor sign-in.
  - Keep `deploy/secrets` private and backed up.
  - Don't expose MOSS to the internet; use a VPN to reach it from away.
  - Keep it updated.

MOSS is provided as-is, without warranty. You are responsible for what you allow it to do on your
network.

---

## 8. Backups, upgrades and getting help

- **Back up:** `sh deploy/backup.sh` saves the database, your secrets and settings, and MOSS's HTTPS
  certificate authority. Keep copies off the machine.
- **Upgrade:** `sh deploy/upgrade.sh` backs up first, builds the new version while the old one
  keeps running, then switches over. `sh deploy/upgrade.sh --rollback` goes back one version.
- **Restore:** `sh deploy/restore.sh <backup>`.
- **Help:** ask **Moss** in Chat first. It knows MOSS's documentation and can read how your install
  is set up. For bugs and ideas, open an issue on GitHub.
