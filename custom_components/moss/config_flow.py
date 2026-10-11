"""Setting MOSS up in Home Assistant: its address and a token made in MOSS.

With MOSS's own HTTPS certificate authority, the flow shows the CA's fingerprint; once the person confirms it
matches what MOSS shows (Settings, HTTPS), the integration trusts that CA, so connections stay verified.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import MossApi, MossAuthError, MossCertError, MossError, fetch_ca, fingerprint, ssl_context
_LOGGER = logging.getLogger(__name__)

from .const import CONF_ASSIST_AGENT, CONF_CA_PEM, CONF_TOKEN, CONF_URL, CONF_VERIFY_SSL, DEFAULT_ASSIST_AGENT, DOMAIN


async def _check(hass: HomeAssistant, url: str, token: str, verify_ssl: bool, ca_pem: str | None = None) -> dict[str, Any]:
    context = await hass.async_add_executor_job(ssl_context, ca_pem) if ca_pem else None
    api = MossApi(async_get_clientsession(hass, verify_ssl=verify_ssl), url, token, verify_ssl, context)
    return await api.state()


class MossConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._pending: dict[str, Any] = {}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            if not url.startswith(("http://", "https://")):
                url = f"https://{url}"
            token = user_input[CONF_TOKEN].strip()
            await self.async_set_unique_id(url.lower())
            self._abort_if_unique_id_configured()
            try:
                await _check(self.hass, url, token, user_input[CONF_VERIFY_SSL])
            except MossCertError:
                # Probably MOSS's own certificate authority: offer to trust it after checking its fingerprint.
                try:
                    ca = await fetch_ca(async_get_clientsession(self.hass), url)
                except MossError:
                    errors["base"] = "cert_untrusted"
                else:
                    self._pending = {**user_input, CONF_URL: url, CONF_TOKEN: token, CONF_CA_PEM: ca}
                    return await self.async_step_trust()
            except MossAuthError:
                errors["base"] = "invalid_auth"
            except MossError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="MOSS", data={**user_input, CONF_URL: url, CONF_TOKEN: token})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, "https://")): str,
                    vol.Required(CONF_TOKEN): str,
                    vol.Optional(CONF_VERIFY_SSL, default=True): bool,
                }
            ),
            errors=errors,
        )

    async def async_step_trust(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show MOSS's CA fingerprint; trust it once the person confirms it matches."""
        errors: dict[str, str] = {}
        p = self._pending
        if user_input is not None:
            try:
                await _check(self.hass, p[CONF_URL], p[CONF_TOKEN], True, p[CONF_CA_PEM])
            except MossAuthError:
                errors["base"] = "invalid_auth"
            except MossCertError as err:
                _LOGGER.warning("MOSS's certificate still isn't trusted: %s", err)
                errors["base"] = "cert_untrusted"
            except MossError as err:
                _LOGGER.warning("Can't reach MOSS: %s", err)
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title="MOSS", data={**p, CONF_VERIFY_SSL: True})
        return self.async_show_form(
            step_id="trust",
            data_schema=vol.Schema({}),
            description_placeholders={"fingerprint": fingerprint(p[CONF_CA_PEM]), "url": p[CONF_URL]},
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                await _check(self.hass, entry.data[CONF_URL], user_input[CONF_TOKEN].strip(), entry.data.get(CONF_VERIFY_SSL, True), entry.data.get(CONF_CA_PEM))
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
