"""MOSS, the AI IT department, in Home Assistant.

Sensors for incidents, monitors, agents and spending; events for automations; safe controls (pause agents,
maintenance mode, raise an incident, ask an agent, check a monitor, run a recurring task); a calendar; an
update entity; an Assist conversation agent; and the Basement card for dashboards. Home Assistant can never
approve changes or touch MOSS's secrets, tools, networks or settings: MOSS's API doesn't offer them.
"""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import MossApi, MossError, ssl_context
from .const import CARD_URL, CONF_CA_PEM, CONF_TOKEN, CONF_URL, CONF_VERIFY_SSL, DEFAULT_ASSIST_AGENT, DOMAIN
from .coordinator import MossCoordinator

PLATFORMS = [
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.SWITCH,
    Platform.SELECT,
    Platform.BUTTON,
    Platform.EVENT,
    Platform.CALENDAR,
    Platform.UPDATE,
    Platform.CONVERSATION,
]

type MossConfigEntry = ConfigEntry[MossCoordinator]

RAISE_SCHEMA = vol.Schema(
    {
        vol.Required("title"): cv.string,
        vol.Optional("description"): cv.string,
        vol.Optional("priority", default="P3"): vol.In(["P1", "P2", "P3", "P4"]),
        vol.Optional("type", default="break_fix"): vol.In(["break_fix", "security", "request"]),
        vol.Optional("agent"): cv.string,
    }
)
ASK_SCHEMA = vol.Schema({vol.Optional("agent", default=DEFAULT_ASSIST_AGENT): cv.string, vol.Required("question"): cv.string})
ACK_SCHEMA = vol.Schema({vol.Required("incident_id"): cv.string})


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry) -> bool:
    ca = entry.data.get(CONF_CA_PEM)
    context = await hass.async_add_executor_job(ssl_context, ca) if ca else None
    verify = entry.data.get(CONF_VERIFY_SSL, True)
    api = MossApi(async_get_clientsession(hass, verify_ssl=verify), entry.data[CONF_URL], entry.data[CONF_TOKEN], verify, context)
    coordinator = MossCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    coordinator.start_events()
    entry.async_on_unload(coordinator.stop_events)

    await _register_card(hass)
    _register_services(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: MossConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _register_card(hass: HomeAssistant) -> None:
    """Serves the Basement card and loads it on every dashboard (once per Home Assistant start)."""
    if hass.data.get(f"{DOMAIN}_card"):
        return
    hass.data[f"{DOMAIN}_card"] = True
    path = Path(__file__).parent / "frontend" / "moss-basement-card.js"
    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(path), False)])
    add_extra_js_url(hass, f"{CARD_URL}?v={int(path.stat().st_mtime)}")


def _coordinator(hass: HomeAssistant) -> MossCoordinator:
    entries = [e for e in hass.config_entries.async_entries(DOMAIN) if getattr(e, "runtime_data", None)]
    if not entries:
        raise HomeAssistantError("MOSS isn't set up")
    return entries[0].runtime_data


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "raise_incident"):
        return

    async def raise_incident(call: ServiceCall) -> ServiceResponse:
        try:
            result = await _coordinator(hass).api.post("incidents", dict(call.data))
        except MossError as err:
            raise HomeAssistantError(str(err)) from err
        await _coordinator(hass).async_request_refresh()
        return {"id": result["id"], "ref": result["ref"]}

    async def ask_agent(call: ServiceCall) -> ServiceResponse:
        try:
            return await _coordinator(hass).api.ask(call.data["agent"], call.data["question"])
        except MossError as err:
            raise HomeAssistantError(str(err)) from err

    async def acknowledge(call: ServiceCall) -> None:
        try:
            await _coordinator(hass).api.post(f"incidents/{call.data['incident_id']}/acknowledge")
        except MossError as err:
            raise HomeAssistantError(str(err)) from err

    hass.services.async_register(DOMAIN, "raise_incident", raise_incident, schema=RAISE_SCHEMA, supports_response=SupportsResponse.OPTIONAL)
    hass.services.async_register(DOMAIN, "ask_agent", ask_agent, schema=ASK_SCHEMA, supports_response=SupportsResponse.ONLY)
    hass.services.async_register(DOMAIN, "acknowledge_incident", acknowledge, schema=ACK_SCHEMA)
