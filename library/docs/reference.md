# Reference (generated)
Generated from MOSS's code by `corepack pnpm gen:reference`. Don't edit by hand.

## Settings
Stored per install; most are switched on the Settings page.

| Setting | Default | What it does |
| --- | --- | --- |
| agents.kill_switch | false | Stops every agent at once: no tool calls run until it's switched off (the kill switch at the bottom of the menu). |
| auth.password_policy | {} | The password policy (Settings → Security): minimum length (12 by default), required kinds of character, how many old passwords can't be reused, maximum age, who must use two-factor sign-in, and an optional check against known-breached passwords. |
| changes.allow_emergency | false | Lets agents raise emergency changes that run straight away and are reviewed afterwards. Off by default. |
| changes.require_separate_approver | false | Requires a change to be approved by someone other than the person who asked for it. |
| homeassistant.allow_resume | false | Whether the Home Assistant integration may resume paused agents (pausing is always allowed). |
| monitoring.quiet_until | "" | Maintenance mode: until this time, monitors keep checking but raise no incidents. Set from Home Assistant. |
| monitoring.retention_days | 14 | How many days of individual monitor check results are kept. |
| moss.announced_version | "" | The newest version Moss has announced in #general (What's new, from library/docs/changelog.md). |
| tools.allow_dangerous | false | Permits tools marked dangerous, such as factory resets, still only through approved changes. Off by default. |
| tools.allow_vulners | false | Allows vuln_scan's cve profile, which sends service names and versions to vulners.com. Off by default. |
| tools.catalog_url | "" | An optional remote tools catalog (an https URL of its index). Empty means only the bundled catalog. |

## Tool adguard_rewrite
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Add or remove an AdGuard Home DNS rewrite (a local DNS record), e.g. nas.lan -> 10.0.0.12. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool adguard_rule
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Block or unblock a domain with an AdGuard Home custom filtering rule, or remove MOSS's rule for it. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool adguard_stats
A network tool (read), run by the toolbox through the policy gate. Read AdGuard Home statistics: queries, how many were blocked, average processing time, and the busiest clients.
Granted by: Home & DNS Actions, Home Lab Integrations.

## Tool arp_scan
A network tool (read), run by the toolbox through the policy gate. Discover devices on a directly attached IPv4 subnet using ARP. Returns IP, MAC and NIC vendor. Only works for subnets the toolbox is directly connected to.
Granted by: Network Discovery.

## Tool config_backup
A network tool (read), run by the toolbox through the policy gate. Back up a device's configuration into MOSS, encrypted. Sources: 'ssh_file' copies one config file over SSH (under /etc, /opt, /srv, /usr/local/etc, /var/lib or a home directory; at most 512 KB); 'pihole' downloads a Pi-hole (v6) Teleporter export. You get back the backup's id, size and SHA-256, never its contents. Take one before changing a device's config.
Granted by: Config Backups.

## Tool container_restart
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Restart, start or stop a Docker container over SSH, then report its new state. Only runs as part of an approved change.
Granted by: Server Actions.

## Tool disk_usage
A network tool (read), run by the toolbox through the policy gate. Report each mounted filesystem's size, use and free space on a Linux server, over SSH.
Granted by: Server Checks.

## Tool dns_lookup
A network tool (read), run by the toolbox through the policy gate. Resolve a hostname to IP addresses (A/AAAA), or an IP to hostnames (PTR), using the toolbox's resolver.
Granted by: Monitoring Response, Network Discovery.

## Tool docker_ps
A network tool (read), run by the toolbox through the policy gate. List the Docker containers on a server over SSH: name, image, state and status. The account must be allowed to use Docker.
Granted by: Server Actions, Server Checks.

## Tool homeassistant_devices
A network tool (read), run by the toolbox through the policy gate. List the devices Home Assistant knows: name, room (area), manufacturer and model, and any MAC and IP addresses it has for them.
Granted by: Home Assistant.

## Tool homeassistant_health
A network tool (read), run by the toolbox through the policy gate. Check Home Assistant's own health: its version, integrations that failed to load, pending updates, and entities that are unavailable.
Granted by: Home Assistant.

## Tool homeassistant_logs
A network tool (read), run by the toolbox through the policy gate. Summarise Home Assistant's error log: counts by level, the most repeated problems grouped by integration (with first and last time seen), and the latest errors. Use it to spot new, growing or unusual problems.
Granted by: Home Assistant.

## Tool homeassistant_power_cycle
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Power-cycle a device on a Home Assistant smart plug: turn the switch off, wait, turn it back on, and report each state. For a hung modem or access point. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool homeassistant_states
A network tool (read), run by the toolbox through the policy gate. Read entity states from Home Assistant (sensors, switches, UPS, batteries...), optionally one domain such as sensor or switch.
Granted by: Home Assistant, Home & DNS Actions, Home Lab Integrations.

## Tool homeassistant_switch
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Turn a Home Assistant switch, light, fan or input_boolean on or off (or toggle it), then report its new state. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool host_facts
A network tool (read), run by the toolbox through the policy gate. Log in to a Linux server over SSH and report its OS, kernel, hostname, uptime, CPU count, memory and load.
Granted by: Server Actions, Server Checks.

## Tool host_reboot
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Schedule a reboot of a Linux server over SSH (sudo -n shutdown -r), a minute or more ahead so the session ends cleanly. Needs passwordless sudo for shutdown. Only runs as part of an approved change.
Granted by: Server Actions.

## Tool http_probe
A network tool (read), run by the toolbox through the policy gate. Make one HTTP(S) request to a host and report the status code, latency and whether an optional keyword appears in the first 256 KB of the body. Does not follow redirects. Use hostHeader for virtual hosts (also used as TLS SNI).
Granted by: Monitoring Response, Service Health Checks.

## Tool name_lookup
A network tool (read), run by the toolbox through the policy gate. Ask devices their own names with unicast NetBIOS, mDNS (Bonjour) and UPnP queries. Finds names for PCs, printers, TVs, speakers and IoT devices that DNS doesn't know. Names found are added to the inventory.
Granted by: Network Insight.

## Tool nmap_scan
A network tool (read), run by the toolbox through the policy gate. Scan hosts with nmap. Profiles: 'ping' (host discovery only), 'top100' (100 most common TCP ports), 'services' (top 1000 TCP ports with service/version detection; slower). Targets must be inside allowed networks.
Granted by: Network Discovery, Security Baseline Review, Service Health Checks.

## Tool nuclei_scan
A network tool (read), run by the toolbox through the policy gate. Check one host with Nuclei's community templates for known vulnerabilities, misconfigurations, exposed admin panels and default pages. Only non-intrusive templates run (no denial-of-service, fuzzing, brute force or default-login attempts), rate-limited, with no out-of-band callbacks. Ports default to 80 and 443.
Granted by: Vulnerability Scanning.

## Tool pihole_domain_rule
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Add or remove an exact domain on Pi-hole's (v6) deny or allow list. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool pihole_local_dns
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Add or remove a local DNS record on Pi-hole (v6), e.g. nas.lan -> 10.0.0.12. Only runs as part of an approved change.
Granted by: Home & DNS Actions.

## Tool pihole_summary
A network tool (read), run by the toolbox through the policy gate. Read Pi-hole (v6) statistics: queries today, how many were blocked, active clients, and the busiest clients.
Granted by: Home & DNS Actions, Home Lab Integrations.

## Tool ping
A network tool (read), run by the toolbox through the policy gate. Send ICMP echo requests to a single host and report packet loss and round-trip time.
Granted by: Monitoring Response, Network Discovery, Service Health Checks.

## Tool proxmox_status
A network tool (read), run by the toolbox through the policy gate. Read a Proxmox VE cluster: each node's status, CPU, memory and disk, and every VM and container's state and usage.
Granted by: Home Lab Integrations.

## Tool service_restart
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Restart, start or stop a systemd service over SSH (sudo -n systemctl), then report its new state. Needs passwordless sudo for systemctl on that server. Only runs as part of an approved change.
Granted by: Server Actions.

## Tool service_status
A network tool (read), run by the toolbox through the policy gate. Report a systemd service's state on a Linux server over SSH: active or failed, since when, and whether it's enabled.
Granted by: Server Actions, Server Checks.

## Tool snmp_query
A network tool (read), run by the toolbox through the policy gate. Read standard SNMP (v2c) data from a device. Presets: 'system' (description, name, uptime, location), 'interfaces' (names, status, speed, traffic counters), 'lldp_neighbors' (what each port is plugged into), 'storage' (disks and memory). The community string must be a stored secret.
Granted by: Network Insight.

## Tool synology_status
A network tool (read), run by the toolbox through the policy gate. Read a Synology NAS (DSM): model, version and temperature, each volume's status and use, and each disk's health.
Granted by: Home Lab Integrations.

## Tool tcp_connect
A network tool (read), run by the toolbox through the policy gate. Open a TCP connection to one port on a host and report whether it was accepted and how long it took. Sends no data.
Granted by: Monitoring Response, Service Health Checks.

## Tool tls_audit
A network tool (read), run by the toolbox through the policy gate. Audit a TLS service in depth with testssl.sh: protocol versions, weak ciphers, certificate problems and known TLS vulnerabilities (Heartbleed, ROBOT and the like). Takes a minute or two.
Granted by: Vulnerability Scanning.

## Tool tls_inspect
A network tool (read), run by the toolbox through the policy gate. Fetch the TLS certificate a host presents and report its subject, issuer, names, expiry and whether the chain is trusted.
Granted by: Monitoring Response, Service Health Checks.

## Tool traceroute
A network tool (read), run by the toolbox through the policy gate. Trace the network path to a host: each hop's address and round-trip time, to find where latency or loss starts. The target must be in an allowed network (add e.g. 1.1.1.1/32 to trace towards the internet).
Granted by: Network Insight.

## Tool truenas_status
A network tool (read), run by the toolbox through the policy gate. Read a TrueNAS system: version and uptime, each storage pool's health, and active alerts.
Granted by: Home Lab Integrations.

## Tool unifi_client_block
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Block or unblock a client (by MAC) on a UniFi network, cutting it off from Wi-Fi and wired ports. Only runs as part of an approved change.
Granted by: UniFi Actions.

## Tool unifi_clients
A network tool (read), run by the toolbox through the policy gate. List the clients a UniFi console knows about: IP, MAC, name, wired or Wi-Fi, and when each connected. The best way to name devices and learn their MACs. Signs in with an API key, or a local account's username and password, stored as secrets. Results are added to the inventory.
Granted by: UniFi Actions.

## Tool unifi_dhcp_reservation
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Give a UniFi client (by MAC) a fixed DHCP address, or clear its reservation. The client must be known to the console. Only runs as part of an approved change.
Granted by: UniFi Actions.

## Tool unifi_firewall
A network tool (read), run by the toolbox through the policy gate. Read a UniFi gateway's security setup (read-only): its networks and VLANs, firewall rules (or zone-based firewall policies on newer versions) with what they allow or block between which networks and ports, and port forwards. Signs in with an API key, or a local account's username and password.
Granted by: Security Baseline Review.

## Tool unifi_wlan_enable
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Turn a UniFi Wi-Fi network (by SSID) on or off, e.g. the guest network. Only runs as part of an approved change.
Granted by: UniFi Actions.

## Tool vuln_scan
A network tool (read), run by the toolbox through the policy gate. Scan one host for known weaknesses with nmap. Profile 'safe': nmap's safe and vuln scripts, with anything intrusive, denial-of-service, brute-force, exploit, fuzzing or third-party excluded (service versions, TLS ciphers, known misconfigurations). Profile 'cve': look up known CVEs for each service version (sends service names and versions to vulners.com, so the owner must allow it in Settings). Ports default to the 100 most common.
Granted by: Vulnerability Scanning.

## Tool wake_on_lan
A network tool (changes things: only through an approved change), run by the toolbox through the policy gate. Power on a device by sending a Wake-on-LAN magic packet to its MAC address via the subnet's broadcast address. Changes device state, so it only runs as part of an approved change.
Granted by: Device Power.

## Tool access_request
A MOSS tool (works on MOSS itself; needs the changes.create permission). Ask for access you don't have: tools (by name) and secrets (by name). It raises a change request; nothing runs, and when a person approves it you get exactly that access and a new task to carry on. Say why you need it.
Granted by: Change Management, Team Memory.

## Tool ask_moss
A MOSS tool (works on MOSS itself; needs the agents.read permission). Ask Moss, the expert on MOSS itself, a question about MOSS: why a tool call was denied, how a setting or module works, how to do something in MOSS. You get Moss's answer back. Not for questions about the network.
Granted by: Incident Management, Team Memory.

## Tool ask_user
A MOSS tool (works on MOSS itself; needs the notifications.send permission). Ask a person a question you need answered before you can carry on: a choice between options, missing information, or a go-ahead. It goes to the person who gave you this task (or who you report to) as a chat message. Then stop: finish this run with a short summary saying what you're waiting for. Their answer comes back to you as a new chat task with the conversation. Once per run; not needed in a chat, where you just ask in your reply.
Granted by: Incident Management, Team Memory.

## Tool change_comment
A MOSS tool (works on MOSS itself; needs the changes.create permission). Add a comment to a change request: answer a question about it, or report progress.
Granted by: Change Management.

## Tool change_complete
A MOSS tool (works on MOSS itself; needs the changes.create permission). Close out a change you executed after verifying it: outcome succeeded or failed, with what you checked.
Granted by: Change Management.

## Tool change_execute
A MOSS tool (works on MOSS itself; needs the changes.create permission). Execute an approved change you raised: runs its planned calls in order through the policy gate and stops at the first failure. Afterwards, verify the result and call change_complete, or change_rollback if it went wrong.
Granted by: Change Management.

## Tool change_get
A MOSS tool (works on MOSS itself; needs the changes.read permission). Read a change request: status, planned and rollback calls, and its timeline.
Granted by: Change Management.

## Tool change_request_create
A MOSS tool (works on MOSS itself; needs the changes.create permission). Raise a change request. Every action that changes a system needs one. List the exact tool calls (plannedCalls) that make the change and, where possible, the calls that undo it (rollbackCalls). Normal changes wait for a human approver; standard changes use a pre-approved template (give standardTemplateKey and templateParams instead of plannedCalls); emergency changes are only for active outages and may be disabled.
Granted by: Change Management.

## Tool change_rollback
A MOSS tool (works on MOSS itself; needs the changes.create permission). Run a change's rollback calls through the gate and mark it rolled back.
Granted by: Change Management.

## Tool chat_post
A MOSS tool (works on MOSS itself; needs the notifications.send permission). Post a message in a chat channel you're a member of (e.g. #network), for updates the people there should see. At most 5 per run. You can @mention people by name.
Granted by: Team Memory.

## Tool incident_comment
A MOSS tool (works on MOSS itself; needs the incidents.manage permission). Add a comment to an incident (findings, progress, questions for the owner).
Granted by: Home Assistant, Incident Management, Vulnerability Scanning.

## Tool incident_create
A MOSS tool (works on MOSS itself; needs the incidents.manage permission). Raise an incident for something broken (break_fix), a security problem (security), or a request. Link affected assets.
Granted by: Home Assistant, Incident Management, Vulnerability Scanning.

## Tool incident_get
A MOSS tool (works on MOSS itself; needs the incidents.read permission). Read an incident with its comments and linked assets.
Granted by: Incident Management.

## Tool incident_list
A MOSS tool (works on MOSS itself; needs the incidents.read permission). List open incidents, optionally only those assigned to you.
Granted by: Home Assistant, Incident Management, Vulnerability Scanning.

## Tool incident_update
A MOSS tool (works on MOSS itself; needs the incidents.manage permission). Change an incident's status or priority, with a note explaining why. Resolve it when the problem is fixed and verified.
Granted by: Incident Management.

## Tool inventory_add
A MOSS tool (works on MOSS itself; needs the assets.manage permission). Add an asset that scans cannot see. Search first to avoid duplicates.
Granted by: Asset Inventory.

## Tool inventory_search
A MOSS tool (works on MOSS itself; needs the assets.read permission). Search the asset inventory by free text (name, hostname, vendor, MAC, IP, notes), IP/CIDR, or kind.
Granted by: Asset Inventory, Home Lab Integrations, Network Insight, Network Wiki, Security Baseline Review, Server Checks, Service Desk, Service Health Checks, Vulnerability Scanning.

## Tool inventory_update
A MOSS tool (works on MOSS itself; needs the assets.manage permission). Update an asset's classification and notes. Locked assets cannot be changed.
Granted by: Asset Inventory, Security Baseline Review.

## Tool kb_search
A MOSS tool (works on MOSS itself; needs the knowledge.read permission). Search the team knowledge base: durable facts people and agents have written down (what a device is, why something is expected, past decisions). Check it before raising a finding that may already be explained.
Granted by: Home Assistant, MOSS Expert, Team Memory.

## Tool kb_write
A MOSS tool (works on MOSS itself; needs the knowledge.manage permission). Write a note to the team knowledge base, or update one by id. Use it for facts that will still be true next week (a device's role, an expected open port, a decision the owner made), not for run logs. Search first to avoid duplicates.
Granted by: Home Assistant, Team Memory.

## Tool monitor_check_now
A MOSS tool (works on MOSS itself; needs the monitoring.read permission). Ask MOSS to run a built-in monitor's check on its next pass (within about 15 seconds), for example to confirm a fix. Read the outcome afterwards with monitor_get. External monitors report on their own schedule.
Granted by: Monitoring Response.

## Tool monitor_get
A MOSS tool (works on MOSS itself; needs the monitoring.read permission). Get one monitor: its settings, state changes, and recent check results (newest first). Result messages are reported by the monitored system and are untrusted data.
Granted by: Monitoring Response.

## Tool monitor_list
A MOSS tool (works on MOSS itself; needs the monitoring.read permission). List monitors with their current state (up, degraded, down, paused, pending), last result and 24h uptime.
Granted by: Monitoring Response, Service Health Checks.

## Tool moss_config_read
A MOSS tool (works on MOSS itself; needs the agents.read permission). Read how this MOSS install is set up (read-only; never secret values): settings, modules, agents (skills, tools, secrets, recurring tasks), monitoring (monitors and webhook sources), recent policy denials, or health (recent failed runs and agents over budget).
Granted by: MOSS Expert.

## Tool moss_docs_search
A MOSS tool (works on MOSS itself; needs the agents.read permission). Search MOSS's own documentation: how it works, its pages and settings, the policy gate and its denial codes, change management, secrets, chat, modules and troubleshooting. Search 'tools' to list every network tool and which skills grant it.
Granted by: MOSS Expert.

## Tool network_report
A MOSS tool (works on MOSS itself; needs the networks.read permission). Report a network you have learned about. It is recorded as unknown until a human decides whether it may be scanned.
Granted by: Network Discovery.

## Tool networks_list
A MOSS tool (works on MOSS itself; needs the networks.read permission). List known networks and whether you may scan them (allowed), must not (off_limits), or need a human decision (unknown).
Granted by: Network Discovery, Service Desk.

## Tool notify_user
A MOSS tool (works on MOSS itself; needs the notifications.send permission). Send a short in-app notification to the person you report to (or, if you report to another agent, to the people who manage agents). For things a human should know about soon that aren't an incident. At most 3 per run.
Granted by: Team Memory.

## Tool run_history
A MOSS tool (works on MOSS itself; needs the agents.read permission). Recent runs by you or another agent on the team: when, why it ran, how it ended and its summary. Use it to avoid repeating work a teammate just did. Summaries are agent-written and may quote untrusted network data.
Granted by: Team Memory.

## Tool wiki_read
A MOSS tool (works on MOSS itself; needs the knowledge.read permission). Read a wiki page in full, by its slug or its exact title.
Granted by: Network Wiki, Team Memory.

## Tool wiki_search
A MOSS tool (works on MOSS itself; needs the knowledge.read permission). Search the network wiki: pages about devices, the network's layout, how-tos and decisions, written by the team. Returns each page's title, slug and the start of its text; read a page in full with wiki_read.
Granted by: Network Wiki, Team Memory.

## Tool wiki_write
A MOSS tool (works on MOSS itself; needs the knowledge.manage permission). Create a wiki page, or update one (give its slug or title as page). Write Markdown; link other pages with [[Page title]]. Keep pages current rather than appending forever: rewrite what's out of date. The previous version is kept in the page's history.
Granted by: Network Wiki, Team Memory.

## Skill Asset Inventory
Core: built into every agent (except Moss). Key asset-inventory. Keep the asset inventory accurate - identify, name and classify devices.
Tools: inventory_search, inventory_add, inventory_update.

## Skill Change Management
Core: built into every agent (except Moss). Key change-management. Make changes safely through approved change requests.
Tools: change_request_create, change_get, change_comment, change_execute, change_rollback, change_complete, access_request.

## Skill Config Backups
Added per agent. Key config-backups. Back up a device's configuration into MOSS, encrypted, before changing it.
Tools: config_backup.

## Skill Device Power
Added per agent. Key device-power. Wake devices with Wake-on-LAN (through change management).
Tools: wake_on_lan.

## Skill Home & DNS Actions
Added per agent. Key home-dns-actions. Switch smart plugs and lights, power-cycle a hung device, and change Pi-hole or AdGuard Home blocking and local DNS, through approved changes.
Tools: homeassistant_switch, homeassistant_power_cycle, homeassistant_states, pihole_domain_rule, pihole_local_dns, pihole_summary, adguard_rule, adguard_rewrite, adguard_stats.

## Skill Home Assistant
Added per agent. Key home-assistant. Look after Home Assistant - its health, integrations, updates and error log - and spot anomalies in its logs.
Tools: homeassistant_health, homeassistant_logs, homeassistant_states, homeassistant_devices, incident_create, incident_list, incident_comment, kb_search, kb_write.

## Skill Home Lab Integrations
Added per agent. Key homelab-integrations. Read Proxmox, TrueNAS, Synology, Home Assistant, Pi-hole and AdGuard Home through their own APIs.
Tools: proxmox_status, truenas_status, synology_status, homeassistant_states, pihole_summary, adguard_stats, inventory_search.

## Skill Incident Management
Core: built into every agent (except Moss). Key incident-management. Raise, work and resolve incidents.
Tools: incident_create, incident_get, incident_list, incident_update, incident_comment, ask_user, ask_moss.

## Skill Monitoring Response
Core: built into every agent (except Moss). Key monitoring-response. Respond to monitoring alerts - confirm, diagnose, fix through change management, and verify.
Tools: monitor_list, monitor_get, monitor_check_now, ping, tcp_connect, http_probe, tls_inspect, dns_lookup.

## Skill MOSS Expert
Added per agent. Key moss-expert. Answer questions about MOSS itself from its documentation and this install's configuration.
Tools: moss_docs_search, moss_config_read, kb_search.

## Skill Network Discovery
Added per agent. Key network-discovery. Find devices and services on the networks you are allowed to scan.
Tools: nmap_scan, arp_scan, ping, dns_lookup, networks_list, network_report.

## Skill Network Insight
Core: built into every agent (except Moss). Key network-insight. Name devices and map the network from the router, SNMP and the devices themselves; trace slow paths.
Tools: name_lookup, snmp_query, traceroute, inventory_search.

## Skill Network Wiki
Core: built into every agent (except Moss). Key network-wiki. Keep the team's network wiki current - devices, layout, how-tos and decisions.
Tools: wiki_search, wiki_read, wiki_write, inventory_search.

## Skill Security Baseline Review
Added per agent. Key security-baseline. Look for exposed services and risky configurations on allowed networks.
Tools: nmap_scan, unifi_firewall, inventory_search, inventory_update.

## Skill Server Actions
Added per agent. Key server-actions. Restart services and containers, or reboot a Linux server, as steps of an approved change request.
Tools: service_restart, container_restart, host_reboot, service_status, docker_ps, host_facts.

## Skill Server Checks
Added per agent. Key server-checks. Check Linux servers over SSH - OS and load, disk space, systemd services and Docker containers - with fixed, read-only commands.
Tools: host_facts, disk_usage, service_status, docker_ps, inventory_search.

## Skill Service Desk
Core: built into every agent (except Moss). Key service-desk. Talk with the owner, answer questions about the network, and triage problems.
Tools: inventory_search, networks_list.

## Skill Service Health Checks
Added per agent. Key service-health. Check that known hosts and services are reachable.
Tools: ping, nmap_scan, tcp_connect, http_probe, tls_inspect, inventory_search, monitor_list.

## Skill Team Memory
Core: built into every agent (except Moss). Key team-memory. Share durable facts in the knowledge base, see what teammates already did, and tell a human when something needs them.
Tools: kb_search, kb_write, wiki_search, wiki_read, wiki_write, run_history, notify_user, chat_post, ask_user, ask_moss, access_request.

## Skill UniFi Actions
Added per agent. Key unifi-actions. Block or unblock a client, set DHCP reservations, and turn Wi-Fi networks on or off on UniFi, through approved changes.
Tools: unifi_client_block, unifi_dhcp_reservation, unifi_wlan_enable, unifi_clients.

## Skill Vulnerability Scanning
Added per agent. Key vulnerability-scanning. Check devices for known vulnerabilities and weak configurations with nmap, Nuclei and testssl.sh, and report what matters.
Tools: vuln_scan, nuclei_scan, tls_audit, inventory_search, incident_create, incident_list, incident_comment.

## Agent templates

| Template | Default name | Skills (besides the core ones) |
| --- | --- | --- |
| Developer | Dev | none |
| Home Automation Specialist | Hana | service-health, device-power, homelab-integrations, home-dns-actions, config-backups |
| IT Manager | Morgan | none |
| MOSS Expert | Moss | moss-expert |
| Network Admin | Nina | network-discovery, device-power, unifi-actions, config-backups |
| Security Admin | Sid | security-baseline, vulnerability-scanning |
| Systems Admin | Sam | service-health, server-checks, server-actions, homelab-integrations, config-backups |

## Roles
Built-in roles and their permissions (Settings → Users).

- Owner (owner): agents.budget, agents.chat, agents.manage, agents.read, assets.manage, assets.read, audit.read, changes.approve, changes.create, changes.read, dashboard.read, dev.manage, dev.read, incidents.manage, incidents.read, integrations.manage, killswitch.use, knowledge.manage, knowledge.read, models.manage, monitoring.manage, monitoring.read, networks.manage, networks.read, notifications.send, secrets.manage, secrets.read, settings.manage, skills.manage, tools.manage, users.manage
- Admin (admin): agents.budget, agents.chat, agents.manage, agents.read, assets.manage, assets.read, audit.read, changes.approve, changes.create, changes.read, dashboard.read, dev.manage, dev.read, incidents.manage, incidents.read, integrations.manage, killswitch.use, knowledge.manage, knowledge.read, models.manage, monitoring.manage, monitoring.read, networks.manage, networks.read, notifications.send, secrets.manage, secrets.read, settings.manage, skills.manage, tools.manage, users.manage
- Change Approver (change_approver): agents.read, assets.read, audit.read, changes.approve, changes.create, changes.read, dashboard.read, dev.read, incidents.manage, incidents.read, knowledge.read, monitoring.read, networks.read, secrets.read
- Operator (operator): agents.chat, agents.read, assets.manage, assets.read, audit.read, changes.create, changes.read, dashboard.read, dev.manage, dev.read, incidents.manage, incidents.read, killswitch.use, knowledge.manage, knowledge.read, monitoring.manage, monitoring.read, networks.read, secrets.read
- Viewer (viewer): agents.read, assets.read, audit.read, changes.read, dashboard.read, dev.read, incidents.read, knowledge.read, monitoring.read, networks.read, secrets.read
- Agent (agent): agents.read, assets.manage, assets.read, changes.create, changes.read, dev.manage, dev.read, incidents.manage, incidents.read, knowledge.manage, knowledge.read, monitoring.read, networks.read, notifications.send
