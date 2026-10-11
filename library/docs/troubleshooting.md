# Troubleshooting

## An agent says a tool was denied
Read the denial's code and reason (on the run page, or moss_config_read "denials") and see the denial
codes in the safety docs. The usual fixes: allow the network, grant the tool or the skill, grant or
re-scope the secret, switch the module on, or raise a change request for a write.

## An agent isn't replying
- Is it paused, fired, or over its hard budget? Is the kill switch on?
- Agents only reply to people allowed to chat with agents, and only to messages from people.
- One run at a time: a reply waits until the agent's current run ends.
- Does it have a model? A model on a Claude subscription needs the worker set up for it.
- Check Agent activity for a failed run and its error.

## A device rejects a credential
- Check what's stored: Settings > Secrets shows each secret's length when saved. A pasted note or a
  trailing space is the usual cause; save it again with only the value.
- Passwords go in password (with the username, which can be stored on the secret), keys in apiKey/token.
- UniFi: use a local account (Admins & Users, "Restrict to local access only"); a Ubiquiti cloud account
  with two-factor sign-in can't sign in this way. An API key needs UniFi Network 9.0 or later.
- Home Assistant: the integration list and the error log need an administrator's token.

## Discovery finds nothing, or every address
Scans only cover allowed networks. Docker Desktop's network answers TCP probes for addresses that don't
exist, so MOSS falls back to ICMP discovery there; ARP only sees networks the toolbox is attached to.

## A monitor never goes up or down
Built-in checks are refused outside allowed networks (the monitor shows "blocked"). External monitors only
change when their source sends an alert; check the source's "last received" time.

## Upgrades fail or the host runs out of space or memory
Docker build cache grows with every upgrade: docker builder prune -af frees it. A build needs a few GB of
free memory. A failed build leaves the running version untouched; --rollback undoes a bad upgrade.
