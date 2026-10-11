"""Buttons: check a monitor now, and run a recurring task now."""

from __future__ import annotations

from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .api import MossError
from .coordinator import MossCoordinator
from .entity import MossEntity, agent_device, by_id


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def add_new() -> None:
        data = coordinator.data or {}
        new: list[ButtonEntity] = []
        for m in data.get("monitors", []):
            if m["kind"] != "external" and f"m-{m['id']}" not in known:
                known.add(f"m-{m['id']}")
                new.append(CheckMonitorButton(coordinator, m))
        for t in data.get("tasks", []):
            if f"t-{t['id']}" not in known:
                agent = by_id(data.get("agents", []), t["agentId"])
                if agent:
                    known.add(f"t-{t['id']}")
                    new.append(RunTaskButton(coordinator, t, agent))
        if new:
            async_add_entities(new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


async def _post(coordinator: MossCoordinator, path: str) -> None:
    try:
        await coordinator.api.post(path)
    except MossError as err:
        raise HomeAssistantError(str(err)) from err


class CheckMonitorButton(MossEntity, ButtonEntity):
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator: MossCoordinator, monitor: dict[str, Any]) -> None:
        super().__init__(coordinator, f"check-{monitor['id']}")
        self._monitor_id = monitor["id"]
        self._attr_name = f"Check {monitor['name']} now"

    @property
    def available(self) -> bool:
        return super().available and by_id(self.data.get("monitors", []), self._monitor_id) is not None

    async def async_press(self) -> None:
        await _post(self.coordinator, f"monitors/{self._monitor_id}/check")


class RunTaskButton(MossEntity, ButtonEntity):
    """Runs one of an agent's recurring tasks now (on that agent's device)."""

    _attr_icon = "mdi:play-circle-outline"

    def __init__(self, coordinator: MossCoordinator, task: dict[str, Any], agent: dict[str, Any]) -> None:
        super().__init__(coordinator, f"task-{task['id']}")
        self._task_id = task["id"]
        short = task["task"].strip().split("\n")[0]
        self._attr_name = f"Run now: {short[:50]}{'…' if len(short) > 50 else ''}"
        self._attr_device_info = agent_device(coordinator, agent)

    @property
    def available(self) -> bool:
        return super().available and by_id(self.data.get("tasks", []), self._task_id) is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        t = by_id(self.data.get("tasks", []), self._task_id) or {}
        return {"task": t.get("task"), "schedule": t.get("when"), "enabled": t.get("enabled")}

    async def async_press(self) -> None:
        await _post(self.coordinator, f"tasks/{self._task_id}/run")
