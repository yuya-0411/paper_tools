"""Fixed deterministic provider for tests and demos."""

from __future__ import annotations

import json
from collections.abc import Callable

from paper_tools.providers.base import ProviderError, ProviderHealth
from paper_tools.providers.parsing import parse_provider_text
from paper_tools.schemas import GenerationRequest, GenerationResponse
from paper_tools.services.planning import PaperPlanningService


class MockProvider:
    def __init__(
        self,
        response: GenerationResponse | str | None = None,
        *,
        factory: Callable[[GenerationRequest], GenerationResponse] | None = None,
        error: str | None = None,
    ) -> None:
        self.response = response
        self.factory = factory
        self.error = error

    @property
    def name(self) -> str:
        return "mock"

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        if self.error is not None:
            raise ProviderError(self.error)
        if self.factory is not None:
            return self.factory(request)
        if isinstance(self.response, GenerationResponse):
            return self.response.model_copy(deep=True)
        if isinstance(self.response, str):
            text = self.response
        else:
            outline = request.outline or PaperPlanningService().plan(request.paper_spec)
            selected = (
                next(
                    (item for item in outline.sections if item.id == request.target_section),
                    None,
                )
                if request.target_section
                else next(iter(outline.sections), None)
            )
            if selected is None:
                raise ProviderError("mock provider has no target section")
            text = json.dumps(
                {
                    "sections": [
                        {
                            "id": selected.id,
                            "title": selected.title,
                            "content": "Fixed mock draft.",
                        }
                    ]
                }
            )
        return parse_provider_text(request, text, provider_name=self.name)

    async def healthcheck(self) -> ProviderHealth:
        return ProviderHealth(available=self.error is None, message="mock provider")
