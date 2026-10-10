"""An Assist conversation agent: talk to a MOSS agent (Moss by default) by text or voice."""

from __future__ import annotations

from typing import Literal

from homeassistant.components import conversation
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import MossConfigEntry
from .api import MossError
from .const import CONF_ASSIST_AGENT, DEFAULT_ASSIST_AGENT
from .coordinator import MossCoordinator
from .entity import MossEntity


async def async_setup_entry(hass: HomeAssistant, entry: MossConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([MossConversation(entry.runtime_data)])


class MossConversation(MossEntity, conversation.ConversationEntity):
    """Each question goes to the agent as a MOSS chat message; the answer comes back here."""

    _attr_name = "Assist"

    def __init__(self, coordinator: MossCoordinator) -> None:
        super().__init__(coordinator, "conversation")

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        return "*"

    @property
    def _agent(self) -> str:
        return self.coordinator.config_entry.options.get(CONF_ASSIST_AGENT, DEFAULT_ASSIST_AGENT)

    async def async_process(self, user_input: conversation.ConversationInput) -> conversation.ConversationResult:
        response = intent.IntentResponse(language=user_input.language)
        try:
            answer = await self.coordinator.api.ask(self._agent, user_input.text, timeout=60)
            response.async_set_speech(answer["reply"])
        except MossError as err:
            response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, f"MOSS couldn't answer: {err}")
        return conversation.ConversationResult(response=response, conversation_id=user_input.conversation_id)
