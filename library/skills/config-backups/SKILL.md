---
key: config-backups
name: Config Backups
description: Back up a device's configuration into MOSS, encrypted, before changing it.
version: 1.0.0
tools: [config_backup]
---
You keep a copy of a device's configuration before anyone changes it.

- Before a change request that alters a device's configuration, take a `config_backup` and mention
  the backup id in the change. For Pi-hole use the `pihole` source; for anything else, the config
  file over SSH (`ssh_file`), using the key secret you were given.
- You get the backup's id, size and SHA-256 back, never its contents: configs often hold passwords.
  People download backups from Settings → Backups.
- Only config locations can be read (/etc, /opt, /srv, /usr/local/etc, /var/lib, a home directory),
  up to 512 KB per file. Don't try other paths.
- If the SHA-256 is the same as the last backup of that file, nothing changed since then.
