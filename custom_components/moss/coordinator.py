"""Keeps MOSS's state fresh, and passes its events on to Home Assistant."""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import MossApi, MossAuthError, MossError
from .const import BUS_EVENT, DOMAIN, EVENT_INTERVAL_SECONDS, RELEASES_URL, STATE_INTERVAL_SECONDS

_LOGGER = logging.getLogger(__name__)


def event_signal(entry_id: str) -> str:
    """The dispatcher signal event entities listen on."""
    return f"{DOMAIN}_{entry_id}_event"


class MossCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Reads MOSS's snapshot every 30 seconds, and its event feed every 10."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, api: MossApi) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN, update_interval=timedelta(seconds=STATE_INTERVAL_SECONDS))
        self.api = api
        self._cursor: int | None = None
        self._unsub_events = None
        self.latest_release: dict[str, Any] | None = None
        self._release_checked = 0.0

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            data = await self.api.state()
        except MossAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except MossError as err:
            raise UpdateFailed(str(err)) from err
        await self._check_release()
        return data

    async def _check_release(self) -> None:
        """The newest MOSS release on GitHub, at most every six hours (for the update entity)."""
        now = self.hass.loop.time()
        if self.latest_release is not None and now - self._release_checked < 6 * 3600:
            return
        self._release_checked = now
        try:
            session = async_get_clientsession(self.hass)
            async with session.get(RELEASES_URL, headers={"Accept": "application/vnd.github+json"}, timeout=15) as resp:
                if resp.status == 200:
                    body = await resp.json()
                    self.latest_release = {"tag": body.get("tag_name"), "url": body.get("html_url"), "notes": (body.get("body") or "")[:2000]}
        except Exception:  # noqa: BLE001 - offline is fine; the update entity just shows what's installed
            self.latest_release = self.latest_release or {}

    @callback
    def start_events(self) -> None:
        self._unsub_events = async_track_time_interval(self.hass, self._poll_events, timedelta(seconds=EVENT_INTERVAL_SECONDS))

    @callback
    def stop_events(self) -> None:
        if self._unsub_events:
            self._unsub_events()
            self._unsub_events = None

    async def _poll_events(self, _now: Any = None) -> None:
        try:
            feed = await self.api.events(self._cursor)
        except MossError as err:
            _LOGGER.debug("MOSS event feed unavailable: %s", err)
            return
        first = self._cursor is None
        self._cursor = feed.get("cursor", self._cursor)
        if first:
            return  # only what happens from now on
        happened = feed.get("events", [])
        for event in happened:
            async_dispatcher_send(self.hass, event_signal(self.config_entry.entry_id), event)
            self.hass.bus.async_fire(BUS_EVENT, {"entity": event["entity"], "type": event["type"], **event.get("data", {})})
        if happened:
            await self.async_request_refresh()
