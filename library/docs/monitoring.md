# Monitoring, incidents and the inventory

## Monitors
Monitoring > Add a monitor: ping, TCP, HTTP(S), TLS expiry or DNS checks, run by MOSS through the same
policy gate as agents (targets must be in allowed networks; MOSS warns you otherwise). Each monitor has
an interval, a failure and recovery threshold, a priority and a responder (an agent or a person).

## Metric monitors
Three kinds record numbers as well as up or down:
- SNMP: one interface (by ifIndex) gives traffic in and out in bits per second, errors per minute and
  whether it's up (rates need two checks); or any numeric OID, optionally as a rate per second for
  counters. The community string is a stored secret. Ask an agent to run snmp_query with the
  interfaces preset to find the ifIndex.
- Host stats: load (1, 5 and 15 minutes), memory used % and the fullest disk %, over SSH with a stored
  key (a read-only account; pin the host key).
- Home Assistant sensor: any entity (sensor.ups_load), read through Settings > Integrations > Home
  Assistant. Numbers keep their unit; on/off count as 1/0; unavailable counts as down.
Thresholds (optional): choose which value they apply to, then degraded above/below and down
above/below. Down raises an incident after the usual number of failed checks. Using a stored secret in
a monitor needs the secrets.manage permission (an SNMP community is sent to the device in the clear),
and the secret's own host and tool limits apply. SNMP and host monitors need an allowed network even
for a public address.

## Webhook sources
Monitoring > Webhook sources connects tools you already run: Uptime Kuma, Beszel, Prometheus
Alertmanager, or any script that posts JSON. Each source has its own URL and token (shown once), and
each alert becomes a monitor in MOSS. The Home Assistant module has its own source.

## When something goes down
After the failure threshold, MOSS opens an incident at the monitor's priority for its responder; an agent
responder starts work straight away. A repeat while the incident is open adds a comment instead. On
recovery the incident is updated, or resolved if the monitor auto-resolves. Outages during an approved
change on the same asset don't open incidents.

## Incidents
Raise one with "Raise an incident" (top right of Incidents). Types: break/fix, security, request.
Priorities P1 (critical) to P4. Assigning an agent starts work. Comments support @mentions.

## Inventory and networks
Agents add what they discover to Assets (matched by MAC, then IP). Lock an asset to stop agents changing
it. Networks lists subnets: allowed (agents may scan and act), off-limits (never), or undecided (refused).
Tables can be sorted by clicking a column header.
