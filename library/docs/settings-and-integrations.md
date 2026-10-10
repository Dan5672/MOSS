# Settings and integrations

## General settings
- Kill switch: pauses every agent immediately.
- Allow emergency changes: agents may make urgent changes without waiting; each is flagged for review.
- Require a separate approver: nobody approves a change they requested.
- Allow dangerous tools: permits tools marked dangerous, still only through approved changes.
- Display > Motion: animations follow the system, or are always on or always off (per person).
- Two-factor authentication (TOTP) for your own sign-in.

## Backups
Settings > Backups lists device configuration backups agents took (encrypted; downloading one is audited).
Backing up MOSS itself is done on the host: sh deploy/backup.sh, and sh deploy/upgrade.sh takes a backup
before every upgrade. Keep deploy/secrets/master.key safe: without it secrets can't be decrypted.

## Integrations
Settings > Integrations (once called Modules): connections to other systems. An integration that is off does nothing and its tools refuse to run.

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
