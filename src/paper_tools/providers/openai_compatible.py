"""Optional OpenAI-compatible chat completions provider."""

from __future__ import annotations

import os
from dataclasses import dataclass

from paper_tools.providers.base import (
    JSONTransport,
    ProviderError,
    ProviderHealth,
    UrllibJSONTransport,
)
from paper_tools.providers.parsing import build_generation_prompt, parse_provider_text
from paper_tools.schemas import GenerationRequest, GenerationResponse


@dataclass(frozen=True, slots=True)
class OpenAICompatibleConfig:
    base_url: str
    model: str
    api_key_env: str = "PAPER_TOOLS_API_KEY"
    timeout: float = 60.0
    temperature: float = 0.2
    max_output_tokens: int = 4096


class OpenAICompatibleProvider:
    def __init__(
        self,
        config: OpenAICompatibleConfig,
        *,
        transport: JSONTransport | None = None,
        environment: dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.transport = transport or UrllibJSONTransport()
        self.environment = environment if environment is not None else os.environ

    @property
    def name(self) -> str:
        return "openai-compatible"

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        api_key = self.environment.get(self.config.api_key_env, "")
        if not api_key:
            raise ProviderError(f"APIキー環境変数 {self.config.api_key_env} が設定されていません")
        payload: dict[str, object] = {
            "model": self.config.model,
            "messages": [
                {
                    "role": "system",
                    "content": "Return safe academic draft JSON based only on supplied facts.",
                },
                {"role": "user", "content": build_generation_prompt(request)},
            ],
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_output_tokens,
            "response_format": {"type": "json_object"},
        }
        response = await self.transport.post_json(
            f"{self.config.base_url.rstrip('/')}/chat/completions",
            payload,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=self.config.timeout,
        )
        try:
            choices = response["choices"]
            first = choices[0]
            content = first["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("OpenAI互換API応答の形式が不正です") from exc
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("OpenAI互換API応答に本文がありません")
        return parse_provider_text(request, content, provider_name=self.name)

    async def healthcheck(self) -> ProviderHealth:
        api_key = self.environment.get(self.config.api_key_env, "")
        if not api_key:
            return ProviderHealth(available=False, message="APIキー環境変数が未設定です")
        try:
            await self.transport.get_json(
                f"{self.config.base_url.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=min(self.config.timeout, 5.0),
            )
        except ProviderError as exc:
            return ProviderHealth(available=False, message=str(exc))
        return ProviderHealth(available=True, message="OpenAI互換APIへ接続できました")
