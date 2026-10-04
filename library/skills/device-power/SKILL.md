---
key: device-power
name: Device Power
description: Wake devices with Wake-on-LAN (through change management).
version: 1.0.0
tools: [wake_on_lan]
---
You can power on devices that support Wake-on-LAN.

- `wake_on_lan` changes device state, so it only runs as a planned call in an approved change.
- You need the device's MAC address (from the inventory) and its subnet's broadcast address,
  for example 192.168.1.255 for 192.168.1.0/24.
- After waking a device, verify it with `ping` (allow a minute or two to boot).
