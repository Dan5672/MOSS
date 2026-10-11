"""Event entities, for automations: incidents, monitors, changes, new devices and agents."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .coordinator import MossCoordinator, event_signal
from .entity import MossEntity

KINDS = {
    "incidents": ("Incident", ["opened", "resolved"], "mdi:alert-circle-outline"),
    "monitors": ("Monitor", ["down", "recovered"], "mdi:heart-pulse"),
    "changes": ("Change", ["waiting_for_approval"], "mdi:clipboard-check-outline"),
    "devices": ("New device", ["new_device"], "mdi:devices"),
    "agents": ("Agent", ["run_finished", "question"], "mdi:robot-outline"),
}


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities(MossEventEntity(entry.runtime_data, kind) for kind in KINDS)


class MossEventEntity(MossEntity, EventEntity):
    def __init__(self, coordinator: MossCoordinator, kind: str) -> None:
        super().__init__(coordinator, f"event-{kind}")
        name, types, icon = KINDS[kind]
        self._kind = kind
        self._attr_name = name
        self._attr_event_types = types
        self._attr_icon = icon

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(async_dispatcher_connect(self.hass, event_signal(self.coordinator.config_entry.entry_id), self._handle))

    @callback
    def _handle(self, event: dict[str, Any]) -> None:
        if event.get("entity") != self._kind or event.get("type") not in self._attr_event_types:
            return
        self._trigger_event(event["type"], event.get("data", {}))
        self.async_write_ha_state()
