"""Shared bits for MOSS entities."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import CONF_URL, DOMAIN
from .coordinator import MossCoordinator


def hub_device(coordinator: MossCoordinator) -> DeviceInfo:
    """MOSS itself: the device most entities belong to."""
    entry = coordinator.config_entry
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="MOSS",
        manufacturer="MOSS",
        model="AI IT department",
        sw_version=(coordinator.data or {}).get("moss", {}).get("version"),
        configuration_url=entry.data[CONF_URL],
        entry_type=DeviceEntryType.SERVICE,
    )


def agent_device(coordinator: MossCoordinator, agent: dict[str, Any]) -> DeviceInfo:
    """Each agent is a device of its own."""
    return DeviceInfo(
        identifiers={(DOMAIN, f"agent-{agent['id']}")},
        name=agent["name"],
        manufacturer="MOSS",
        model=agent["title"],
        configuration_url=f"{coordinator.config_entry.data[CONF_URL].rstrip('/')}/agents/{agent['id']}",
        entry_type=DeviceEntryType.SERVICE,
    )


class MossEntity(CoordinatorEntity[MossCoordinator]):
    """A MOSS entity on the MOSS device."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: MossCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.config_entry.entry_id}-{key}"
        self._attr_device_info = hub_device(coordinator)

    @property
    def data(self) -> dict[str, Any]:
        return self.coordinator.data or {}


def by_id(items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
    return next((i for i in items if i["id"] == item_id), None)
