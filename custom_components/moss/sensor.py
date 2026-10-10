"""MOSS sensors: incidents, monitors, changes, agents, spending, security, and one sensor per agent."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorEntityDescription, SensorStateClass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import MossConfigEntry
from .coordinator import MossCoordinator
from .entity import MossEntity, agent_device, by_id


@dataclass(frozen=True, kw_only=True)
class MossSensorDescription(SensorEntityDescription):
    value: Callable[[dict[str, Any]], Any]
    attrs: Callable[[dict[str, Any]], dict[str, Any]] = lambda d: {}


def _ts(value: str | None) -> datetime | None:
    return dt_util.parse_datetime(value) if value else None


SENSORS: tuple[MossSensorDescription, ...] = (
    MossSensorDescription(
        key="open_incidents",
        name="Open incidents",
        icon="mdi:alert-circle-outline",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["summary"]["openIncidents"],
        attrs=lambda d: {"highest_priority": d["summary"]["highestPriority"], "newest": d["summary"]["newestIncident"]},
    ),
    MossSensorDescription(
        key="monitors_down",
        name="Monitors down",
        icon="mdi:lan-disconnect",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["summary"]["monitorsDown"],
        attrs=lambda d: {"down": d["summary"]["downNames"], "degraded": d["summary"]["monitorsDegraded"], "responder_id": d["basement"]["responderId"]},
    ),
    MossSensorDescription(
        key="changes_pending",
        name="Changes waiting for approval",
        icon="mdi:clipboard-check-outline",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["summary"]["changesPending"],
    ),
    MossSensorDescription(
        key="agents_working",
        name="Agents working",
        icon="mdi:robot-outline",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["summary"]["agentsWorking"],
        attrs=lambda d: {"on_break": d["summary"]["agentsOnBreak"], "paused": d["summary"]["agentsPaused"], "all_paused": d["summary"]["killSwitch"]},
    ),
    MossSensorDescription(
        key="spend_today",
        name="Spend today",
        icon="mdi:cash",
        device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="USD",
        suggested_display_precision=2,
        value=lambda d: round(d["budget"]["todayUsd"], 4),
        attrs=lambda d: {"daily_limit": d["budget"]["dailyLimitUsd"]},
    ),
    MossSensorDescription(
        key="spend_month",
        name="Spend this month",
        icon="mdi:cash-multiple",
        device_class=SensorDeviceClass.MONETARY,
        native_unit_of_measurement="USD",
        suggested_display_precision=2,
        value=lambda d: round(d["budget"]["monthUsd"], 4),
        attrs=lambda d: {
            "monthly_limit": d["budget"]["monthlyLimitUsd"],
            "percent_of_limit": round(100 * d["budget"]["monthUsd"] / d["budget"]["monthlyLimitUsd"], 1) if d["budget"]["monthlyLimitUsd"] else None,
        },
    ),
    MossSensorDescription(
        key="security_incidents",
        name="Open security incidents",
        icon="mdi:shield-alert-outline",
        state_class=SensorStateClass.MEASUREMENT,
        value=lambda d: d["security"]["openSecurityIncidents"],
    ),
    MossSensorDescription(
        key="last_config_backup",
        name="Last config backup",
        icon="mdi:backup-restore",
        device_class=SensorDeviceClass.TIMESTAMP,
        value=lambda d: max((_ts(b["at"]) for b in d["security"]["backups"]), default=None),
        attrs=lambda d: {"devices": {b["target"]: b["at"] for b in d["security"]["backups"]}},
    ),
)

AGENT_STATUSES = ["working", "on_break", "paused"]


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator = entry.runtime_data
    async_add_entities(MossSensor(coordinator, d) for d in SENSORS)

    known: set[str] = set()

    @callback
    def add_agents() -> None:
        new = [a for a in (coordinator.data or {}).get("agents", []) if a["id"] not in known]
        known.update(a["id"] for a in new)
        if new:
            async_add_entities(AgentSensor(coordinator, a) for a in new)

    add_agents()
    entry.async_on_unload(coordinator.async_add_listener(add_agents))


class MossSensor(MossEntity, SensorEntity):
    entity_description: MossSensorDescription

    def __init__(self, coordinator: MossCoordinator, description: MossSensorDescription) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        return self.entity_description.value(self.data)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return self.entity_description.attrs(self.data)


class AgentSensor(MossEntity, SensorEntity):
    """An agent: what it's doing now, how its last run went, and what it has cost today."""

    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = AGENT_STATUSES
    _attr_name = "Status"
    _attr_translation_key = "agent_status"

    def __init__(self, coordinator: MossCoordinator, agent: dict[str, Any]) -> None:
        super().__init__(coordinator, f"agent-{agent['id']}")
        self._agent_id = agent["id"]
        self._attr_device_info = agent_device(coordinator, agent)

    @property
    def agent(self) -> dict[str, Any] | None:
        return by_id(self.data.get("agents", []), self._agent_id)

    @property
    def available(self) -> bool:
        return super().available and self.agent is not None

    @property
    def native_value(self) -> str | None:
        return self.agent["status"] if self.agent else None

    @property
    def entity_picture(self) -> str | None:
        return self.agent["picture"] if self.agent else None

    @property
    def icon(self) -> str:
        return {"working": "mdi:laptop", "on_break": "mdi:coffee", "paused": "mdi:pause-circle"}.get(self.native_value or "", "mdi:robot")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        a = self.agent
        if not a:
            return {}
        return {
            "moss_agent_id": a["id"],
            "agent_name": a["name"],
            "agent_title": a["title"],
            "task": a["task"],
            "working_since": a["since"],
            "last_run_status": (a["lastRun"] or {}).get("status"),
            "last_run_ended": (a["lastRun"] or {}).get("endedAt"),
            "last_run_summary": (a["lastRun"] or {}).get("summary"),
            "runs_today": a["runsToday"],
            "cost_today": round(a["costTodayUsd"], 4),
            "glow": a["glow"],
            "responding": self.data.get("basement", {}).get("responderId") == a["id"] and bool(self.data.get("basement", {}).get("down")),
        }
