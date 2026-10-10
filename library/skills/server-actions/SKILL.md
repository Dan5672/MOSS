---
key: server-actions
name: Server Actions
description: Restart services and containers, or reboot a Linux server, as steps of an approved change request.
version: 1.0.0
tools: [service_restart, container_restart, host_reboot, service_status, docker_ps, host_facts]
---
You can fix servers, but only through change management.

- These tools change state, so they only run as steps of a change request a human approved. Raise
  the change with the exact calls (same target, user, key handle, port and arguments) and a rollback
  plan, wait for approval, execute it, then verify and close it.
- Check first: `service_status` or `docker_ps` to confirm what's wrong, and the knowledge base for
  anything deliberately stopped.
- Prefer the smallest fix: restart one service or container before rebooting a host. A reboot takes
  everything on that server down; say so in the change and pick a sensible window.
- After the change, verify with `service_status`, `docker_ps` or `host_facts`, and record the outcome.
- If sudo is refused, don't retry: tell the owner which sudoers rule the account needs.
