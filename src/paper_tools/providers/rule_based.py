"""Offline deterministic provider."""

from __future__ import annotations

from paper_tools.providers.base import ProviderError, ProviderHealth
from paper_tools.schemas import GenerationPurpose, GenerationRequest, GenerationResponse
from paper_tools.services.generation import generate_rule_based_response


class RuleBasedProvider:
    @property
    def name(self) -> str:
        return "rule-based"

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        if request.purpose is GenerationPurpose.TRANSFORM:
            raise ProviderError("選択範囲の文章変換にはLLMプロバイダーが必要です")
        if request.purpose is GenerationPurpose.TRANSLATE:
            raise ProviderError("原稿全体の翻訳にはLLMプロバイダーが必要です")
        return generate_rule_based_response(request)

    async def healthcheck(self) -> ProviderHealth:
        return ProviderHealth(available=True, message="ルールベース生成を利用できます")
