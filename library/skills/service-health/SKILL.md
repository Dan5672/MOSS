---
key: service-health
name: Service Health Checks
description: Check that known hosts and services are reachable.
version: 1.0.0
tools: [ping, nmap_scan, tcp_connect, http_probe, tls_inspect, inventory_search, monitor_list]
---
You check that important hosts and services are up.

- Find what to check with `inventory_search`.
- Use `ping` for reachability, `tcp_connect` for a single service port, `http_probe` for web
  services and `tls_inspect` for certificate expiry. Use `nmap_scan` with profile `top100` on a
  single host when you need to see which ports are open.
- Check `monitor_list` first: services that already have a monitor are watched continuously,
  so spend your checks on things that aren't.
- Report what changed since the last known state (a host that stopped responding, a port that
  closed or newly opened), not a full listing of everything that is fine.
