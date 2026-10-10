---
key: server-actions
name: Server Actions
description: Restart services and containers, reboot a Linux server, or snapshot and power Proxmox guests, as steps of an approved change request.
version: 1.1.0
tools: [service_restart, container_restart, host_reboot, proxmox_snapshot, proxmox_guest_power, service_status, docker_ps, host_facts, proxmox_status]
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
- Proxmox guests: make `proxmox_snapshot` (named for the change, e.g. before_upgrade) the first step of any
  change to a VM or container, so the rollback plan can say "roll back to that snapshot".
  `proxmox_guest_power` shuts a guest down cleanly, starts it or reboots it; as with servers, prefer
  restarting the one service inside the guest over rebooting it. Check the result with `proxmox_status`.
