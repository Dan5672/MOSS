"""One binary sensor per MOSS monitor (on = there's a problem), plus maintenance mode."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .coordinator import MossCoordinator
from .entity import MossEntity, by_id


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    async_add_entities([MaintenanceSensor(coordinator)])
    known: set[str] = set()

    @callback
    def add_monitors() -> None:
        new = [m for m in (coordinator.data or {}).get("monitors", []) if m["id"] not in known]
        known.update(m["id"] for m in new)
        if new:
            async_add_entities(MonitorSensor(coordinator, m) for m in new)

    add_monitors()
    entry.async_on_unload(coordinator.async_add_listener(add_monitors))


class MonitorSensor(MossEntity, BinarySensorEntity):
    """A monitor: on while it's down (or degraded), off while it's up."""

    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, coordinator: MossCoordinator, monitor: dict[str, Any]) -> None:
        super().__init__(coordinator, f"monitor-{monitor['id']}")
        self._monitor_id = monitor["id"]
        self._attr_name = f"Monitor {monitor['name']}"

    @property
    def monitor(self) -> dict[str, Any] | None:
        return by_id(self.data.get("monitors", []), self._monitor_id)

    @property
    def available(self) -> bool:
        m = self.monitor
        return super().available and m is not None and m["enabled"] and m["state"] != "paused"

    @property
    def is_on(self) -> bool | None:
        m = self.monitor
        if not m or m["state"] == "unknown":
            return None
        return m["state"] in ("down", "degraded")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        m = self.monitor
        if not m:
            return {}
        return {
            "moss_monitor_id": m["id"],
            "state": m["state"],
            "kind": m["kind"],
            "uptime_24h": round(m["uptime24h"] * 100, 2) if m["uptime24h"] is not None else None,
            "last_check": m["lastCheckAt"],
            "message": m["message"],
            "asset": m["asset"],
        }


class MaintenanceSensor(MossEntity, BinarySensorEntity):
    """On while monitoring is in maintenance mode (nothing that goes down opens an incident)."""

    _attr_name = "Maintenance mode"
    _attr_icon = "mdi:wrench-clock"

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "maintenance")

    @property
    def is_on(self) -> bool:
        return bool(self.data.get("summary", {}).get("quietUntil"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"until": self.data.get("summary", {}).get("quietUntil")}
