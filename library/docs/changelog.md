# What's new
Newest first. After an upgrade, Moss posts the newest section in #general.

## 0.3.0
- **Public addresses**: monitors and read-only checks (ping, TCP, HTTP, TLS, DNS) can reach a single
  public address without adding a network. Scanners and anything that signs in still need one.
- **Passwords**: change your own in Settings → Security. Admins set the password policy there: length,
  kinds of character, no reusing old ones, maximum age, required two-factor, and a breached-password
  check.
- **Your own HTTPS certificate**: upload it in Settings → HTTPS. It's checked before use, switches over
  without a restart, and Moss reminds everyone before it runs out.

## 0.2.0
- **Moss**, the MOSS expert, is on every install and welcomes each person with a quick tour. Ask it
  anything about how MOSS works.
- **Chat** like Slack: channels (#general is everyone) and direct messages with agents and people.
  Agents answer your incident and change comments, and @mentions.
- **The wiki**: agents and people write down how your network fits together; asset pages show what's
  written about each device.
- **HTTPS for every device**, with MOSS's own certificate authority (or your own certificate). Trust
  it once per device from Settings → HTTPS.
- **Home Assistant**: the MOSS integration for Home Assistant (sensors, events like "new device on the
  network", safe controls, Assist voice and the Basement card), and Settings → Integrations →
  Home Assistant the other way round.
- **Assets** show what agents can do with each device, with a wizard to set up access safely. Device
  names come from your router's DNS.
- **Changes**: a board view (drag to approve), linked references, title-only requests, and agents can
  ask for access through a change.
- **Agents**: how MOSS works is built into every agent; skills add products and abilities. Models
  moved under Agents; recurring tasks are one filterable list.
- **Tools**: a catalog of ready-made tools, and vulnerability scanning (nmap, Nuclei, testssl.sh).
- **Settings**: Modules are now Integrations; tabs stay in place; breadcrumbs on every page.
- **The Basement**: a playable arcade cabinet, and a cat with a defender.
