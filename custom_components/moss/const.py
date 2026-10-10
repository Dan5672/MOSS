"""Constants for the MOSS integration."""

DOMAIN = "moss"

CONF_URL = "url"
CONF_TOKEN = "token"
CONF_VERIFY_SSL = "verify_ssl"
CONF_ASSIST_AGENT = "assist_agent"
# MOSS's own certificate authority, trusted after the person checked its fingerprint.
CONF_CA_PEM = "ca_pem"

DEFAULT_ASSIST_AGENT = "Moss"

# How often MOSS's state is read, and how often its event feed is checked.
STATE_INTERVAL_SECONDS = 30
EVENT_INTERVAL_SECONDS = 10

# Where newer MOSS releases are announced (for the update entity).
RELEASES_URL = "https://api.github.com/repos/Dan5672/MOSS/releases/latest"

# Fired on Home Assistant's event bus for everything in MOSS's feed, for automations.
BUS_EVENT = "moss_event"

CARD_URL = "/moss_static/moss-basement-card.js"
