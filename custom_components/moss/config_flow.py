"""Setting MOSS up in Home Assistant: its address and a token made in MOSS."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import MossApi, MossAuthError, MossError
from .const import CONF_ASSIST_AGENT, CONF_TOKEN, CONF_URL, CONF_VERIFY_SSL, DEFAULT_ASSIST_AGENT, DOMAIN


async def _check(hass, url: str, token: str, verify_ssl: bool) -> dict[str, Any]:
    api = MossApi(async_get_clientsession(hass, verify_ssl=verify_ssl), url, token, verify_ssl)
    return await api.state()


class MossConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            if not url.startswith(("http://", "https://")):
                url = f"http://{url}"
            await self.async_set_unique_id(url.lower())
            self._abort_if_unique_id_configured()
            try:
                await _check(self.hass, url, user_input[CONF_TOKEN].strip(), user_input[CONF_VERIFY_SSL])
            except MossAuthError:
                errors["base"] = "invalid_auth"
            except MossError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="MOSS", data={**user_input, CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, "http://")): str,
                    vol.Required(CONF_TOKEN): str,
                    vol.Optional(CONF_VERIFY_SSL, default=True): bool,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await _check(self.hass, entry.data[CONF_URL], user_input[CONF_TOKEN].strip(), entry.data.get(CONF_VERIFY_SSL, True))
            except MossAuthError:
                errors["base"] = "invalid_auth"
            except MossError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data={**entry.data, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return MossOptionsFlow()


class MossOptionsFlow(OptionsFlow):
    """Which MOSS agent answers in Assist."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        names = [DEFAULT_ASSIST_AGENT]
        try:
            names = [a["name"] for a in await self.config_entry.runtime_data.api.agents()] or names
        except (MossError, AttributeError):
            pass
        current = self.config_entry.options.get(CONF_ASSIST_AGENT, DEFAULT_ASSIST_AGENT)
        if current not in names:
            names.insert(0, current)
        return self.async_show_form(step_id="init", data_schema=vol.Schema({vol.Required(CONF_ASSIST_AGENT, default=current): vol.In(names)}))
