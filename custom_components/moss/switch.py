"""Pause all agents. Turning it off (resuming) only works if MOSS's owner allowed that from Home Assistant."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .api import MossError
from .coordinator import MossCoordinator
from .entity import MossEntity


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([PauseAgentsSwitch(entry.runtime_data)])


class PauseAgentsSwitch(MossEntity, SwitchEntity):
    _attr_name = "Pause all agents"
    _attr_icon = "mdi:robot-off-outline"

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "pause_agents")

    @property
    def is_on(self) -> bool:
        return bool(self.data.get("summary", {}).get("killSwitch"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"resume_allowed": bool(self.data.get("summary", {}).get("allowResume"))}

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._call("agents/pause")

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._call("agents/resume")

    async def _call(self, path: str) -> None:
        try:
            await self.coordinator.api.post(path)
        except MossError as err:
            raise HomeAssistantError(str(err)) from err
        await self.coordinator.async_refresh()
