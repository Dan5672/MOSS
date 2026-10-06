---
key: unifi-actions
name: UniFi Actions
description: Block or unblock a client, set DHCP reservations, and turn Wi-Fi networks on or off on UniFi, through approved changes.
version: 1.0.0
tools: [unifi_client_block, unifi_dhcp_reservation, unifi_wlan_enable, unifi_clients]
---
You can change the UniFi network, but only through change management.

- These tools only run as steps of a change request a human approved, with the exact calls,
  including the console address and the API key handle.
- Blocking cuts a device off completely. Do it for a device that looks compromised or unknown, say
  why, and include unblocking as the rollback.
- A DHCP reservation takes effect when the client next renews its lease; it doesn't move it
  straight away. Make sure the address is outside other devices' use (check the inventory).
- Turning off a Wi-Fi network disconnects everyone on it. Use it for the guest network, not the main one.
