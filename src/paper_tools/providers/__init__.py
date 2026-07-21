"""Swappable text-generation providers."""

from paper_tools.providers.base import (
    FallbackProvider,
    ProviderError,
    ProviderHealth,
    TextGenerationProvider,
)
from paper_tools.providers.mock import MockProvider
from paper_tools.providers.ollama import OllamaProvider, OllamaProviderConfig
from paper_tools.providers.openai_compatible import (
    OpenAICompatibleConfig,
    OpenAICompatibleProvider,
)
from paper_tools.providers.rule_based import RuleBasedProvider

__all__ = [
    "FallbackProvider",
    "MockProvider",
    "OllamaProvider",
    "OllamaProviderConfig",
    "OpenAICompatibleConfig",
    "OpenAICompatibleProvider",
    "ProviderError",
    "ProviderHealth",
    "RuleBasedProvider",
    "TextGenerationProvider",
]
