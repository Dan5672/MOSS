"""A calendar of MOSS's change windows and agents' recurring tasks."""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from . import MossConfigEntry
from .api import MossError
from .coordinator import MossCoordinator
from .entity import MossEntity


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([MossCalendar(entry.runtime_data)], update_before_add=True)


def _event(item: dict) -> CalendarEvent:
    return CalendarEvent(
        start=dt_util.parse_datetime(item["start"]),
        end=dt_util.parse_datetime(item["end"]),
        summary=item["summary"],
        description=item.get("description"),
        uid=item["uid"],
    )


class MossCalendar(MossEntity, CalendarEntity):
    _attr_name = "Schedule"
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "calendar")
        self._next: CalendarEvent | None = None

    @property
    def event(self) -> CalendarEvent | None:
        return self._next

    async def async_update(self) -> None:
        now = dt_util.utcnow()
        try:
            items = await self.coordinator.api.calendar(now.isoformat(), (now + timedelta(days=7)).isoformat())
        except MossError:
            return
        upcoming = [_event(i) for i in items]
        self._next = next((e for e in upcoming if e.end > now), None)

    async def async_get_events(self, hass: HomeAssistant, start_date: datetime, end_date: datetime) -> list[CalendarEvent]:
        try:
            items = await self.coordinator.api.calendar(start_date.isoformat(), end_date.isoformat())
        except MossError:
            return []
        return [_event(i) for i in items]
