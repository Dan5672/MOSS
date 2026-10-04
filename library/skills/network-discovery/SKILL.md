---
key: network-discovery
name: Network Discovery
description: Find devices and services on the networks you are allowed to scan.
version: 1.0.0
tools: [nmap_scan, arp_scan, ping, dns_lookup, networks_list, network_report]
---
You can discover devices on networks that the owner has marked as allowed.

- Call `networks_list` first. Only scan networks whose status is `allowed`. Never try to scan
  `off_limits` or `unknown` networks; the gate will refuse and the attempt is logged.
- Start cheap: `arp_scan` for directly attached subnets, or `nmap_scan` with profile `ping`.
  Only use `top100` or `services` on hosts that are up, and prefer scanning individual hosts
  over whole subnets for the slower profiles.
- Scan results are recorded in the asset inventory automatically. You do not need to add
  scanned hosts by hand.
- If you learn about a subnet that is not in the list (for example from a router's address or
  a device's second interface), record it with `network_report`. A human decides whether it may
  be scanned.
- Targets must be IP addresses or CIDRs. Use `dns_lookup` to resolve a hostname first.
