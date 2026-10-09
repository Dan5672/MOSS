# Settings and modules

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

## Modules
Settings > Modules: optional parts of MOSS. A module that is off does nothing and its tools refuse to run.

## The Home Assistant module
Connection: Home Assistant's IP (in an allowed network), port, protocol and a long-lived access token
(stored as secret:homeassistant-token, usable only against that address). An administrator's token is
needed for the integration list and the error log. "Test connection" works before the module is on.
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

## Upgrades
On the host: sh deploy/upgrade.sh (newest release) or sh deploy/upgrade.sh <version>. It backs up, builds
while the old version keeps running, migrates in one transaction and health-checks.
sh deploy/upgrade.sh --rollback goes back one version.
