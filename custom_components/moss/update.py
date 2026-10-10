"""Shows when a newer MOSS release is out. Upgrading stays on the MOSS host (deploy/upgrade.sh)."""

from __future__ import annotations

import re

from homeassistant.components.update import UpdateEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .coordinator import MossCoordinator
from .entity import MossEntity

VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")


def release_of(version: str | None) -> tuple[int, int, int] | None:
    """The release a version is built on: v0.1.1-58-gc7ca845 is v0.1.1 plus 58 commits."""
    m = VERSION.match(version or "")
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([MossUpdate(entry.runtime_data)])


class MossUpdate(MossEntity, UpdateEntity):
    _attr_name = None  # the device's own name: update.moss
    _attr_title = "MOSS"

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "update")

    @property
    def installed_version(self) -> str | None:
        return self.data.get("moss", {}).get("version")

    @property
    def latest_version(self) -> str | None:
        latest = (self.coordinator.latest_release or {}).get("tag")
        installed = self.installed_version
        mine, theirs = release_of(installed), release_of(latest)
        # Only a newer release counts; a build ahead of the last release is up to date.
        if latest and mine and theirs and theirs > mine:
            return latest
        return installed

    @property
    def release_url(self) -> str | None:
        return (self.coordinator.latest_release or {}).get("url")

    @property
    def release_summary(self) -> str | None:
        notes = (self.coordinator.latest_release or {}).get("notes")
        return f"{notes[:250]}\n\nUpgrade on the MOSS host: sh deploy/upgrade.sh" if notes else None
