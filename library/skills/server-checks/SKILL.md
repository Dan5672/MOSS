---
key: server-checks
name: Server Checks
description: Check Linux servers over SSH - OS and load, disk space, systemd services and Docker containers - with fixed, read-only commands.
version: 1.0.0
tools: [host_facts, disk_usage, service_status, docker_ps, inventory_search]
---
You check the health of Linux servers from the inside.

- Each check runs one fixed, read-only command over SSH. Log in with the key secret you were given
  (for example `secret:nas-ssh`) and the account the owner set up for it. Passwords are not
  supported. Never ask for, or type, a key yourself.
- Results include the server's host key fingerprint. If a check reports a host key mismatch, stop
  and raise a security incident: something may be impersonating the server.
- Note pinned fingerprints, accounts and what runs where in the knowledge base if you have it.
- Disks above about 85% full, failed services and containers that keep restarting are worth an
  incident. A container that is stopped on purpose is not: check the knowledge base first.
