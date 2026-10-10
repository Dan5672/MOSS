"""Maintenance mode: quiet MOSS's monitors for an hour or a few while you work on the network."""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .api import MossError
from .coordinator import MossCoordinator
from .entity import MossEntity

HOURS = {"Off": 0, "1 hour": 1, "2 hours": 2, "4 hours": 4}


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([MaintenanceSelect(entry.runtime_data)])


class MaintenanceSelect(MossEntity, SelectEntity):
    """Choosing a duration starts maintenance mode from now; Off ends it."""

    _attr_name = "Maintenance mode"
    _attr_icon = "mdi:wrench-clock"
    _attr_options = list(HOURS)

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "maintenance_select")
        self._chosen = "1 hour"

    @property
    def current_option(self) -> str:
        return self._chosen if self.data.get("summary", {}).get("quietUntil") else "Off"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"until": self.data.get("summary", {}).get("quietUntil")}

    async def async_select_option(self, option: str) -> None:
        try:
            await self.coordinator.api.post("maintenance", {"hours": HOURS[option]})
        except MossError as err:
            raise HomeAssistantError(str(err)) from err
        if option != "Off":
            self._chosen = option
        await self.coordinator.async_refresh()
