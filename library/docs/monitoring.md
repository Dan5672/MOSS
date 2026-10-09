# Monitoring, incidents and the inventory

## Monitors
Monitoring > Add a monitor: ping, TCP, HTTP(S), TLS expiry or DNS checks, run by MOSS through the same
policy gate as agents (targets must be in allowed networks; MOSS warns you otherwise). Each monitor has
an interval, a failure and recovery threshold, a priority and a responder (an agent or a person).

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
