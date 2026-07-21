"""Optional local Ollama provider."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from paper_tools.providers.base import (
    JSONTransport,
    ProviderError,
    ProviderHealth,
    UrllibJSONTransport,
)
from paper_tools.providers.parsing import build_generation_prompt, parse_provider_text
from paper_tools.schemas import GenerationRequest, GenerationResponse


@dataclass(frozen=True, slots=True)
class OllamaProviderConfig:
    base_url: str = "http://127.0.0.1:11434"
    model: str = "llama3.2"
    timeout: float = 60.0
    temperature: float = 0.2


class OllamaProvider:
    def __init__(
        self,
        config: OllamaProviderConfig | None = None,
        *,
        transport: JSONTransport | None = None,
    ) -> None:
        self.config = config or OllamaProviderConfig()
        self.transport = transport or UrllibJSONTransport()

    @property
    def name(self) -> str:
        return "ollama"

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        payload: dict[str, object] = {
            "model": self.config.model,
            "prompt": build_generation_prompt(request),
            "stream": False,
            "format": "json",
            "options": {"temperature": self.config.temperature},
        }
        response = await self.transport.post_json(
            f"{self.config.base_url.rstrip('/')}/api/generate",
            payload,
            headers={},
            timeout=self.config.timeout,
        )
        content = response.get("response")
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("Ollama応答に本文がありません")
        return parse_provider_text(request, content, provider_name=self.name)

    async def healthcheck(self) -> ProviderHealth:
        try:
            response = await self.transport.get_json(
                f"{self.config.base_url.rstrip('/')}/api/tags",
                headers={},
                timeout=min(self.config.timeout, 5.0),
            )
        except ProviderError as exc:
            return ProviderHealth(available=False, message=str(exc))
        models: Any = response.get("models")
        return ProviderHealth(
            available=isinstance(models, list),
            message="Ollamaへ接続できました"
            if isinstance(models, list)
            else "Ollama応答が不正です",
        )
