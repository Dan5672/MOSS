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

## History
Every check is kept for monitoring.retention_days (14 by default). The worker also rolls checks up
every 5 minutes into 5-minute and hourly buckets (availability, latency and every value as min, average
and max), kept for 90 days and 2 years. Graphs use raw checks for up to a day and a half, 5-minute
buckets up to a month, and hourly ones beyond.

## Dashboards
Monitoring > Dashboards: as many as you like. Shared ones are seen by everyone with monitoring.read and
edited by people with monitoring.manage; your own are only for you. The first visit makes a shared
"Overview" from the monitors (status grid, open incidents, 24-hour up/down history, response times, and
a value card per metric monitor). Edit to change it: drag cards to reorder, drag the corner to resize
(or use the buttons on each card: move, narrower/wider, shorter/taller), the gear for a card's settings,
"Add a card" for more. Cards:
- Graph: one value (response time, availability, the main value, or a named one such as inBps) for up
  to 20 monitors over 1 hour to 1 year. Hover for values.
- Gauge: a dial between a low and high mark, amber and red from levels you set.
- Value: one monitor's current value, with its trend.
- Up/down history: a bar per slot of the range and the availability %.
- Status grid: every monitor as a coloured tile, problems first (the "tactical overview").
- Top list: the highest (or lowest) values, e.g. the slowest services or busiest interfaces.
- Open incidents, and Note (Markdown).
Dashboards refresh every minute. TV mode (/tv/dashboards/<id>) is full screen with no menus and refreshes
every 30 seconds, for a wall screen.

## Webhook sources
Monitoring > Webhook sources connects tools you already run: Uptime Kuma, Beszel, Prometheus
Alertmanager, or any script that posts JSON. Each source has its own URL and token (shown once), and
each alert becomes a monitor in MOSS. The Home Assistant module has its own source.

## The Device logs integration
Devices that can send syslog (firewalls, switches, NAS boxes, Proxmox, ESXi) can send it to MOSS, so
agents can read what a device logged without holding a credential for it. It is off until someone with
integrations.manage switches it on in Settings > Integrations > Device logs; while it's off, MOSS refuses
the collector's lines, the Logs tab says so, and `logs_search` returns nothing (lines already stored are
kept until they age out). Once it's on, add a "Device logs" source in
Webhook sources, put the three lines it shows in deploy/.env, and run `docker compose up -d` in deploy:
that starts the collector (Vector), which listens on port 514, UDP and TCP, of the MOSS host. Then point
each device's remote syslog at that host. The Logs tab shows what arrived.
- Lines are kept only from senders inside an allowed network (Settings > Networks), or listed under
  "Accepted senders" on the Logs tab, and never from an off-limits network. Accepted senders don't let
  agents scan or act on those addresses.
- Syslog has no sign-in: anyone on your network can send a line that claims to be any device. Over UDP
  even the sender's address can be faked, so those lines show as "unverified" and aren't linked to a
  device. Over TCP the address is much harder to fake, and lines are linked to the inventory device at
  that address: use TCP where the device offers it. The hostname, app and message are always the
  device's own words, shown and given to agents as data, never as instructions.
- Agents search logs with `logs_search`, in the Device Logs skill. It isn't given to agents by default:
  add the skill on the page of each agent that should read logs. Log lines can hold user
  names, and mistyped passwords in failed sign-ins; what an agent reads goes to its model provider.
- Debug lines are dropped. The collector passes at most 100 lines a second from one address and 500 a
  second in all; a flood (or someone faking many addresses) can drown out real lines while it lasts.
  Logs are kept for 7 days (logs.retention_days), and at most 1,000,000 lines (logs.max_rows; the oldest
  go first).
- Syslog over UDP can lose lines, and a device that stops logging looks the same as a quiet one: keep
  monitors for up and down.
- Docker Desktop (Windows and Mac) shows every sender as Docker's own address (`docker compose logs web`
  names refused senders). Add that one address to Accepted senders, not to
  Networks; every device then looks the same, so none are linked to the inventory. On Linux, Docker
  keeps the real sender's address.

## When something goes down
After the failure threshold, MOSS opens an incident at the monitor's priority for its responder; an agent
responder starts work straight away. A repeat while the incident is open adds a comment instead. On
recovery the incident is updated, or resolved if the monitor auto-resolves. Outages during an approved
change on the same asset don't open incidents.
Agent instructions (optional, on any monitor, in "When it goes down"): guidance for the responding
agent, up to 2,000 characters, e.g. what the device is and what to check first. They go into the incident
with the name of whoever last changed them, kept apart from the monitored system's own text. Only people
who can manage monitors set them (never a webhook, an integration or an agent), and they can't widen what
the agent may do: it still has only its own tools, and risky actions still need an approved change.

## Dependencies
Optional, off by default: Monitoring, "Turn on dependencies". Then each monitor's Edit has "Depends on",
e.g. a VM's monitor depends on its Proxmox host's. While a monitor is down, or has started failing, the
monitors that depend on it (directly or further down) raise no incident or notification of their own:
one dead host is one alarm, and its incident lists what depends on it. Their outages still show on their
pages, marked "quiet". When the host comes back, anything that depends on it and is still down raises its
own alarm. The Map tab draws the dependency tree, coloured by state. Turning dependencies off keeps what
you set but holds nothing back.

## Incidents
Raise one with "Raise an incident" (top right of Incidents). Types: break/fix, security, request.
Priorities P1 (critical) to P4. Assigning an agent starts work. Comments support @mentions.

## Inventory and networks
Agents add what they discover to Assets (matched by MAC, then IP). Lock an asset to stop agents changing
it. Networks lists subnets: allowed (agents may scan and act), off-limits (never), or undecided (refused).
Tables can be sorted by clicking a column header.
