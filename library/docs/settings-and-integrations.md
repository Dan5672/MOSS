# Settings and integrations

## General settings
- Kill switch: pauses every agent immediately.
- Allow emergency changes: agents may make urgent changes without waiting; each is flagged for review.
- Require a separate approver: nobody approves a change they requested.
- Allow dangerous tools: permits tools marked dangerous, still only through approved changes.
- Display > Motion: animations follow the system, or are always on or always off (per person).
- Two-factor authentication (TOTP) for your own sign-in.

## Backups
Settings > Backups has two parts.
MOSS backups (needs settings.manage and secrets.manage): back up now, or a schedule (daily or weekly at an
hour in the install's time zone, keeping the newest N, 10 by default). The backup service writes the same
archives as sh deploy/backup.sh into deploy/backups on the host: database, secrets including the master
key, .env, and the HTTPS certificates. Downloading one needs a fresh two-factor code (so two-factor must be
on) and a passphrase of 12+ characters; the file (.enc) is encrypted with it (openssl, AES-256, PBKDF2).
sh deploy/restore.sh <file> asks for the passphrase. Downloads and deletes are audited. If the backup
service isn't reachable, the page says so; sh deploy/backup.sh on the host still works, and
sh deploy/upgrade.sh takes a backup before every upgrade. Keep copies on another machine.
Device config backups: configurations agents took with config_backup (encrypted by the gate; downloading
one is audited).

## Integrations
Settings > Integrations (once called Modules): connections to other systems. An integration that is off does nothing and its tools refuse to run.
Apart from Home Assistant, every integration's page has the same parts. Connection: the product's IPv4
address (in an allowed network), port, and its credential, stored as a secret usable only against that
address and that integration's tools (changing it needs secrets.manage); Test connection works before
it's on. Features: what it runs in the background (health checks, inventory sync), the priority of its
incidents and who responds. Last runs: what each feature found, with Sync now. Health checks become
monitors under the integration's own source, with readings you can graph on dashboards; when the product
can't be reached, its "<name>" monitor goes down. Inventory syncs match devices by the product's own id,
MAC, then IP; they rename only automatically named assets, never touch locked ones, link VMs and
containers to what they run on, and mark ones the product no longer reports as missing. Agents can still
use the product's tools without the integration, with a granted secret.

## The Home Assistant integration
Connection: Home Assistant's IP (in an allowed network), port, protocol and a long-lived access token
(stored as secret:homeassistant-token, usable only against that address). An administrator's token is
needed for the integration list and the error log. "Test connection" works before the integration is on.
Features, each with its own switch:
- Alerts: automations post to a webhook with a rest_command (the page gives you the YAML); each key is
  a monitor, and problem: true opens an incident.
- Health checks every 5 minutes: reachable, failed integrations, pending updates, unavailable entities.
- Phone notifications: new incidents at or above a priority go to notify.mobile_app_* services.
- Status sensors: sensor.moss_open_incidents, sensor.moss_monitors_down, sensor.moss_changes_pending,
  binary_sensor.moss_agents_paused.
- Inventory sync: daily, or Sync now; matches devices to assets by MAC or IP.
- Internet self-heal: when a chosen monitor has been down for N minutes, an agent power-cycles the modem
  plug through a pre-approved standard change, once per incident.
- Log review: a chosen agent reads the error log daily and raises incidents for anomalies.

## MOSS in Home Assistant (the integration)
A Home Assistant integration (custom_components/moss in the MOSS repository; also downloadable from Settings,
Integrations, Home Assistant) shows MOSS in Home Assistant. Set up: install it (HACS custom repository, or unzip
into config/custom_components), make a token on the Home Assistant integration page in MOSS, then add the MOSS
integration in Home Assistant with MOSS's address and the token. A token acts as the person who made it.
It gives: summary sensors, a sensor per agent, a binary sensor per monitor, event entities (incidents,
monitors, changes, new devices, agents; also the moss_event bus event), a pause-all-agents switch, a
maintenance mode select (monitors raise no incidents for 1, 2 or 4 hours), check-now and run-now buttons,
the actions moss.raise_incident, moss.ask_agent and moss.acknowledge_incident, a calendar, an update
entity and an Assist conversation agent (its agent is chosen in the integration's options). The Basement
card is custom:moss-basement-card (compact: true for a strip).
Home Assistant can't approve changes or reach secrets, tools, networks or settings. Resuming agents from
Home Assistant is refused unless "Let Home Assistant resume agents" is ticked. Troubleshooting: "Invalid
or revoked token" means make a new token; entities unavailable means Home Assistant can't reach MOSS's
address (it must be reachable from Home Assistant, e.g. http://<MOSS host IP>:3000).

## The Telegram integration
Settings > Integrations > Telegram: your own bot (create it with @BotFather, /newbot, and paste its token;
stored as secret:telegram-bot-token, usable by nothing but MOSS's chat bridge). Switch it on, then each
person connects their own account in Settings > General > Connect Telegram, which shows a one-time code
(10 minutes) to send the bot as /link CODE. Messages from accounts that aren't connected are ignored, and
groups are ignored. People get their own MOSS notifications there, filtered by the integration's
settings: incidents (P2 and up by default), monitors, changes awaiting approval, and mentions, comments and
agents' replies, with links if MOSS's address is set. Changes come with Approve and Reject buttons for
people who may approve; the decision is recorded as them, with the same rules as in MOSS (separate
approver, conflicts). Emergency, high-risk and dangerous changes, and agents' access requests, must be
approved in MOSS. Writing to the bot talks to Moss; /agents lists the agents, /agent <name> switches,
/unlink disconnects. The conversation is the person's DM with that agent in MOSS, so it shows in Chat too;
agents only answer people with agents.chat. The bridge polls Telegram, so nothing has to reach MOSS from
the internet.

## The Discord integration
Settings > Integrations > Discord: the same as Telegram, with a Discord bot (Developer Portal: create an
application, Bot, Reset Token; under Installation allow User Install, or invite the bot to a server you
share). Token: secret:discord-bot-token. People connect in Settings > General > Connect Discord and send
the bot /link CODE in a direct message; messages in servers are ignored. Buttons update the message with
the result.

## The Proxmox VE integration
Settings > Integrations > Proxmox VE. Connection: any node's address, port 8006, and an API token
(Datacenter > Permissions > API Tokens, pasted as USER@REALM!TOKENID=SECRET; the PVEAuditor role is enough
to read), stored as secret:proxmox-token. Health checks (every 5 minutes): a monitor per node (with CPU,
memory and disk as readings), per storage pool (degraded at 90% used and down at 98%, both adjustable),
and per VM or container set to start at boot (down when it isn't running; guests that aren't set to
start at boot are left alone). VMs and containers in the inventory (every 6 hours): nodes, VMs and
containers as assets, each guest under its node, matched by MAC to devices MOSS already knows, with the
addresses Proxmox knows (containers, and VMs with the QEMU guest agent); deleted guests are marked
missing. Agent tools: proxmox_status, proxmox_inventory, and the change-gated proxmox_snapshot (take a
snapshot first in any change to a guest) and proxmox_guest_power (shutdown, start, reboot; the token then
needs VM.Snapshot and VM.PowerMgmt).

## The Proxmox Backup Server integration
Settings > Integrations > Proxmox Backup Server. Connection: its address, port 8007, and an API token
(Configuration > Access Control > API Token, as USER@REALM!TOKENID:SECRET, with DatastoreAudit), stored
as secret:pbs-token. Backup checks (every 30 minutes): a monitor per guest that's backed up, down when its
last backup is older than the limit (2 days by default), with the hours since as a reading; and one per
datastore, degraded at 85% used and down at 95%. Agent tool: pbs_status.

## The Docker integration
Settings > Integrations > Docker. MOSS reads Docker through a read-only socket proxy on each host, never the
Docker socket itself (full Docker access is root): for example tecnativa/docker-socket-proxy with
CONTAINERS=1, IMAGES=1, INFO=1 and POST=0, published on port 2375 to the LAN only. Connection: the hosts,
one per line (with :port if not 2375); each must be in an allowed network; no credential. Health checks
(every 5 minutes): a "Docker on <host>" monitor per host, and one per container with a restart policy
(always, unless-stopped, on-failure), down when it's stopped, restarting in a loop or unhealthy; other
containers may be stopped on purpose and are left alone. Containers in the inventory (every 6 hours): each
host and its containers, with image and Compose project; removed containers are marked missing. Image update
check (daily, optional): asks each image's registry (Docker Hub, GHCR...) for the tag's digest with a HEAD
request, sending only image names, and marks containers with a newer image. Restarting a container stays the
change-gated container_restart over SSH. Agent tool: docker_api_containers.

## The OPNsense integration
Settings > Integrations > OPNsense. Connection: its address, port and https, an API key (System > Access >
Users, create a key for a dedicated user) and its secret (secret:opnsense-api-secret). Gateway checks
(every 5 minutes): a monitor per gateway, degraded on packet loss (5% by default) and down when offline,
with latency and loss as readings; the last run notes when an update is waiting. Device names from DHCP
(every 6 hours): leases from Kea, dnsmasq or ISC name devices in the inventory. Blocking: the change-gated
opnsense_block adds or removes an address in the moss_blocked alias; create a Host(s) alias with that name
and a block rule that uses it. MOSS never edits rules. Agent tools: opnsense_status, opnsense_block (skill:
Firewall Actions).

## The pfSense integration
Settings > Integrations > pfSense. pfSense has no API of its own: install the pfSense REST API package
(pfrest), then create a key (System > REST API > Keys), stored as secret:pfsense-api-key. The same gateway
checks and device names as OPNsense, and pfsense_block for the moss_blocked alias (it applies the change).
Agent tools: pfsense_status, pfsense_block.

## The UPS (Network UPS Tools) integration
Settings > Integrations > UPS (Network UPS Tools). Connection: the machine running upsd (the NUT server
the UPS is plugged into, or a NAS sharing its UPS over NUT), port 3493; it must allow MOSS's address
(LISTEN in upsd.conf). A upsd user and password only if it needs one (secret:nut-password). UPS checks (every
minute): a monitor per UPS, down on battery or low battery (raising an incident) and degraded when the
battery needs replacing, with charge, runtime left, load and input voltage as readings.
Shutdown plan (on the same page): an ordered list of steps (Proxmox VMs and containers, shut down through
the Proxmox VE integration's connection; Linux servers, powered off over SSH with a stored key and
passwordless sudo for shutdown), an agent to carry it out (it's granted the plan's tools and secrets), and
the minutes left at which to act (10 by default, or when the UPS reports a low battery). How it runs:
"Ask for approval each time" raises the plan as a normal change, so approvers get it (with Approve and
Reject buttons in Telegram or Discord); "Approved in advance" is approved once by someone who can approve
changes, with a fresh two-factor code, as a standard change, so MOSS raises it already approved. Changing
the steps withdraws the approval. If the power comes back before the plan finishes, MOSS cancels the
change. Changing the plan needs integrations.manage and secrets.manage. Agent tools: nut_status, and the
change-gated host_shutdown.

## The Pi-hole integration
Settings > Integrations > Pi-hole (v6 or newer). Connection: its address, port (80) and http/https, and an
app password (Pi-hole: Settings > Web interface / API > Configure app password), stored as
secret:pihole-password. Health checks (every 5 minutes): a "Pi-hole" monitor (is it answering) and a
"Pi-hole blocking" monitor, degraded when blocking is paused and down when it has failed, with queries,
blocked, the block rate and active clients as readings. Device names (every 6 hours): the devices Pi-hole
has seen (by MAC, with their reverse-DNS names) go into the inventory. Agent tools: pihole_summary,
pihole_clients, and the change-gated pihole_domain_rule and pihole_local_dns.

## The AdGuard Home integration
Settings > Integrations > AdGuard Home. Connection: its address, port and http/https, the user name and
password (secret:adguard-password). Health checks: an "AdGuard Home" monitor and an "AdGuard Home
protection" monitor (degraded when protection is off), with queries, the block rate and the average
response time as readings. Device names: its configured clients (with their addresses and MACs) and the
ones it found. Agent tools: adguard_stats, adguard_clients, and the change-gated adguard_rule and
adguard_rewrite.

## Passwords and two-factor (Settings > Security)
Everyone can change their own password there. People with settings.manage set the password policy: minimum
length (at least 12), required lowercase, capital, digit or symbol, how many old passwords can't be reused,
how often passwords must change (0 = never), who must use two-factor sign-in (optional, owners and admins, or
everyone), and an optional check against known-breached passwords (Have I Been Pwned's range API; only the
first 5 characters of the password's SHA-1 are sent). It applies when a password is set: adding a person or
changing a password. Someone who must set up two-factor is sent to Settings until they do; someone whose
password has expired is sent to Settings > Security. Requiring two-factor needs it on for the person saving the
policy first, so they can't lock themselves out, and it can't then be turned off by someone it applies to.
People who sign in with SSO have no MOSS password and are left out.

## HTTPS
New installs serve MOSS over HTTPS to the whole network (deploy/.env: COMPOSE_PROFILES=https,
MOSS_SECURE_COOKIES=true). MOSS_TLS=internal (default): MOSS's own certificate authority; each device
trusts it once by downloading /moss-ca.crt (Settings, HTTPS shows it, its SHA-256 fingerprint and steps for
Windows, macOS, iOS, Android). With settings.manage you can upload your own certificate there instead (PEM:
the full chain and an unencrypted key; a .pfx converts with openssl pkcs12 -nodes). It's checked first (key
matches, in date, chain in order, covers at least one of MOSS_HTTPS_HOSTS; uncovered names and a missing
chain are warnings), then the https service switches to it without a restart. If the service refuses it,
nothing changes. "Use MOSS's own certificate" switches back and deletes the uploaded key. Moss reminds
everyone in #general 30 and 7 days before an uploaded certificate runs out. Backups include it.
MOSS_TLS=files (older option): your own cert.pem (full chain) and key.pem in deploy/certs.
MOSS_HTTPS_HOSTS lists the names and IPs the certificate covers; a browser warning about the name usually
means the address used isn't in that list (add it and restart). The Home Assistant integration shows the
fingerprint at setup and then trusts MOSS's CA. Backups include the CA.

## Upgrades
On the host: sh deploy/upgrade.sh (newest release) or sh deploy/upgrade.sh <version>. It backs up, builds
while the old version keeps running, migrates in one transaction and health-checks.
sh deploy/upgrade.sh --rollback goes back one version.
