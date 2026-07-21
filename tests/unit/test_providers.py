from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from typing import Any

import pytest

from paper_tools.providers import (
    FallbackProvider,
    MockProvider,
    OllamaProvider,
    OllamaProviderConfig,
    OpenAICompatibleConfig,
    OpenAICompatibleProvider,
    ProviderError,
    RuleBasedProvider,
)
from paper_tools.providers.base import UrllibJSONTransport, _NoRedirectHandler
from paper_tools.providers.parsing import build_generation_prompt, parse_provider_text
from paper_tools.schemas import (
    GenerationPurpose,
    GenerationRequest,
    OutlineSection,
    PaperLanguage,
    PaperOutline,
    PaperSpec,
)


class FakeTransport:
    def __init__(
        self,
        *,
        post_response: Mapping[str, Any] | None = None,
        get_response: Mapping[str, Any] | None = None,
        error: ProviderError | None = None,
    ) -> None:
        self.post_response = post_response or {}
        self.get_response = get_response or {}
        self.error = error
        self.posts: list[tuple[str, Mapping[str, object], Mapping[str, str], float]] = []

    async def post_json(
        self,
        url: str,
        payload: Mapping[str, object],
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]:
        if self.error:
            raise self.error
        self.posts.append((url, payload, headers, timeout))
        return self.post_response

    async def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]:
        if self.error:
            raise self.error
        return self.get_response


class _UnreadableRedirectResponse:
    def __init__(self) -> None:
        self.closed = False
        self.read_called = False

    def read(self, *_args: object) -> bytes:
        self.read_called = True
        raise AssertionError("redirect response bodies must not be read")

    def close(self) -> None:
        self.closed = True


def _request(**spec: object) -> GenerationRequest:
    return GenerationRequest(paper_spec=PaperSpec.model_validate(spec))


def test_rule_based_provider_is_always_available() -> None:
    health = asyncio.run(RuleBasedProvider().healthcheck())

    assert health.available


def test_mock_provider_returns_independent_fixed_response() -> None:
    request = _request(summary="fact")
    expected = asyncio.run(RuleBasedProvider().generate(request))
    provider = MockProvider(expected)

    first = asyncio.run(provider.generate(request))
    second = asyncio.run(provider.generate(request))

    assert first == second == expected
    assert first is not expected


def test_mock_provider_can_raise_sanitized_error() -> None:
    with pytest.raises(ProviderError, match="offline"):
        asyncio.run(MockProvider(error="offline").generate(_request()))


def test_fallback_provider_uses_rule_based_on_failure() -> None:
    provider = FallbackProvider(MockProvider(error="offline"), RuleBasedProvider())

    response = asyncio.run(provider.generate(_request(summary="supplied fact")))

    assert response.fallback_used
    assert response.provider_name == "rule-based"
    assert "offline" in response.warnings[0]


def test_transport_rejects_redirect_before_reading_body_or_forwarding_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _UnreadableRedirectResponse()
    target_url = "https://redirect-target.invalid/collect"

    class RedirectingOpener:
        def __init__(self, redirect_handler: _NoRedirectHandler) -> None:
            self.redirect_handler = redirect_handler

        def open(self, request: Any, *, timeout: float) -> Any:
            del timeout
            assert request.get_header("Authorization") == "Bearer secret-key"
            return self.redirect_handler.redirect_request(
                request,
                response,
                302,
                "Found",
                {"Location": target_url},
                target_url,
            )

    def fake_build_opener(*handlers: object) -> RedirectingOpener:
        redirect_handlers = [item for item in handlers if isinstance(item, _NoRedirectHandler)]
        assert len(redirect_handlers) == 1
        return RedirectingOpener(redirect_handlers[0])

    monkeypatch.setattr("paper_tools.providers.base.build_opener", fake_build_opener)

    with pytest.raises(ProviderError, match="HTTP 302"):
        asyncio.run(
            UrllibJSONTransport().get_json(
                "https://provider.invalid/v1/models",
                headers={"Authorization": "Bearer secret-key"},
                timeout=1.0,
            )
        )

    assert response.closed
    assert not response.read_called


def test_transport_rejects_non_http_urls() -> None:
    with pytest.raises(ProviderError, match="URL"):
        asyncio.run(
            UrllibJSONTransport().get_json(
                "ftp://provider.invalid/models",
                headers={},
                timeout=1.0,
            )
        )


def test_ollama_provider_builds_nonstreaming_safe_request() -> None:
    content = json.dumps(
        {"sections": [{"id": "introduction", "title": "Intro", "content": "Draft"}]}
    )
    transport = FakeTransport(post_response={"response": content})
    provider = OllamaProvider(
        OllamaProviderConfig(model="local-model", timeout=12.0), transport=transport
    )

    response = asyncio.run(provider.generate(_request(objective="Supplied objective")))

    assert response.provider_name == "ollama"
    assert response.section("introduction") is not None
    _, payload, headers, timeout = transport.posts[0]
    assert payload["model"] == "local-model"
    assert payload["stream"] is False
    assert headers == {}
    assert timeout == 12.0


def test_ollama_empty_response_is_rejected() -> None:
    provider = OllamaProvider(transport=FakeTransport(post_response={"response": ""}))

    with pytest.raises(ProviderError, match="本文"):
        asyncio.run(provider.generate(_request()))


def test_ollama_healthcheck_does_not_raise_when_offline() -> None:
    provider = OllamaProvider(transport=FakeTransport(error=ProviderError("offline")))

    health = asyncio.run(provider.healthcheck())

    assert not health.available
    assert health.message == "offline"


def test_openai_compatible_requires_environment_key() -> None:
    provider = OpenAICompatibleProvider(
        OpenAICompatibleConfig(base_url="https://example.invalid/v1", model="model"),
        transport=FakeTransport(),
        environment={},
    )

    with pytest.raises(ProviderError, match="環境変数"):
        asyncio.run(provider.generate(_request()))


def test_openai_compatible_sends_key_only_in_header() -> None:
    content = json.dumps(
        {"sections": [{"id": "introduction", "title": "Intro", "content": "Draft"}]}
    )
    transport = FakeTransport(post_response={"choices": [{"message": {"content": content}}]})
    provider = OpenAICompatibleProvider(
        OpenAICompatibleConfig(base_url="https://example.invalid/v1", model="model"),
        transport=transport,
        environment={"PAPER_TOOLS_API_KEY": "secret-key"},
    )

    response = asyncio.run(provider.generate(_request(objective="Supplied objective")))

    assert response.provider_name == "openai-compatible"
    _, payload, headers, _ = transport.posts[0]
    assert headers["Authorization"] == "Bearer secret-key"
    assert "secret-key" not in json.dumps(payload)


def test_external_provider_output_always_gets_verify_marker() -> None:
    request = _request(
        language=PaperLanguage.ENGLISH,
        template_id="generic-en",
        objective="Supplied objective",
    )

    response = parse_provider_text(
        request,
        json.dumps(
            {
                "sections": [
                    {"id": "abstract", "title": "Abstract", "content": "Generated paragraph"}
                ]
            }
        ),
        provider_name="test",
    )

    assert "[VERIFY:" in response.sections[0].content
    assert response.missing_information


def test_provider_prompt_includes_only_target_text_and_requested_style() -> None:
    request = GenerationRequest(
        paper_spec=PaperSpec(
            language=PaperLanguage.ENGLISH,
            template_id="generic-en",
            english_variant="british",
            background="Sensitive background must not be sent for a selection transform.",
        ),
        purpose=GenerationPurpose.TRANSFORM,
        target_section="abstract",
        existing_sections={
            "abstract": "Selected source text.",
            "introduction": "Unrelated private section.",
        },
        instruction="Shorten the selected text.",
    )

    prompt = build_generation_prompt(request)

    assert "Selected source text." in prompt
    assert "Unrelated private section." not in prompt
    assert "Sensitive background" not in prompt
    assert "british English" in prompt
    assert "Shorten the selected text." in prompt


def test_transform_response_does_not_insert_verify_marker() -> None:
    request = GenerationRequest(
        paper_spec=PaperSpec(language="en", template_id="generic-en"),
        purpose=GenerationPurpose.TRANSFORM,
        target_section="abstract",
    )

    response = parse_provider_text(
        request,
        json.dumps({"sections": [{"id": "abstract", "content": "Revised selection."}]}),
        provider_name="test",
    )

    assert response.sections[0].content == "Revised selection."
    assert response.missing_information == []


def test_rule_based_provider_rejects_selection_transform() -> None:
    request = GenerationRequest(
        paper_spec=PaperSpec(),
        purpose=GenerationPurpose.TRANSFORM,
        target_section="abstract",
    )

    with pytest.raises(ProviderError, match="LLM"):
        asyncio.run(RuleBasedProvider().generate(request))


def test_full_translation_prompt_and_response_cover_the_complete_manuscript() -> None:
    outline = PaperOutline(
        title="入力原稿",
        template_id="generic-en",
        language="en",
        sections=[
            OutlineSection(id="abstract", title="概要", order=0),
            OutlineSection(id="method", title="手法", order=1),
        ],
    )
    request = GenerationRequest(
        paper_spec=PaperSpec(
            title="入力原稿",
            language="en",
            template_id="generic-en",
            keywords=["制御", "評価"],
        ),
        purpose=GenerationPurpose.TRANSLATE,
        outline=outline,
        existing_sections={"abstract": "概要本文．", "method": "手法本文．"},
        instruction="Translate the complete manuscript into English.",
    )

    prompt = build_generation_prompt(request)
    response = parse_provider_text(
        request,
        json.dumps(
            {
                "document_title": "Input Manuscript",
                "keywords": ["control", "evaluation"],
                "sections": [
                    {"id": "abstract", "title": "Abstract", "content": "Abstract body."},
                    {"id": "method", "title": "Method", "content": "Method body."},
                ],
            }
        ),
        provider_name="test",
    )

    assert "概要本文．" in prompt
    assert "手法本文．" in prompt
    assert "every source section represented exactly once" in prompt
    assert response.document_title == "Input Manuscript"
    assert response.translated_keywords == ["control", "evaluation"]
    assert [section.id for section in response.sections] == ["abstract", "method"]
    assert all("[VERIFY:" not in section.content for section in response.sections)


def test_translation_requires_all_sections_and_rejects_rule_based_provider() -> None:
    outline = PaperOutline(
        title="原稿",
        template_id="generic-en",
        language="en",
        sections=[
            OutlineSection(id="abstract", title="Abstract", order=0),
            OutlineSection(id="method", title="Method", order=1),
        ],
    )
    request = GenerationRequest(
        paper_spec=PaperSpec(title="原稿", language="en", template_id="generic-en"),
        purpose=GenerationPurpose.TRANSLATE,
        outline=outline,
        existing_sections={"abstract": "概要", "method": "手法"},
    )
    incomplete = json.dumps(
        {
            "document_title": "Manuscript",
            "keywords": [],
            "sections": [{"id": "abstract", "content": "Abstract"}],
        }
    )

    with pytest.raises(ProviderError, match="不足セクション"):
        parse_provider_text(request, incomplete, provider_name="test")
    with pytest.raises(ProviderError, match="LLM"):
        asyncio.run(RuleBasedProvider().generate(request))


def test_transform_and_translation_reject_invented_numeric_or_citation_tokens() -> None:
    transform = GenerationRequest(
        paper_spec=PaperSpec(language="en", template_id="generic-en"),
        purpose=GenerationPurpose.TRANSFORM,
        target_section="abstract",
        existing_sections={"abstract": "Measured 6.1 mm @Known [VERIFY: check]."},
    )
    with pytest.raises(ProviderError, match="数値，引用キー"):
        parse_provider_text(
            transform,
            json.dumps(
                {
                    "sections": [
                        {
                            "id": "abstract",
                            "content": "Measured 7.2 mm @Invented [VERIFY: check].",
                        }
                    ]
                }
            ),
            provider_name="test",
        )

    outline = PaperOutline(
        title="原稿2026",
        template_id="generic-en",
        language="en",
        sections=[OutlineSection(id="abstract", title="概要", order=0)],
    )
    translation = GenerationRequest(
        paper_spec=PaperSpec(title="原稿2026", language="en", template_id="generic-en"),
        purpose=GenerationPurpose.TRANSLATE,
        outline=outline,
        existing_sections={"abstract": "結果は6.1 mmである @Known．"},
    )
    with pytest.raises(ProviderError, match="数値，引用キー"):
        parse_provider_text(
            translation,
            json.dumps(
                {
                    "document_title": "Manuscript 2026",
                    "keywords": [],
                    "sections": [
                        {
                            "id": "abstract",
                            "content": "The result was 6.2 mm @Known.",
                        }
                    ],
                }
            ),
            provider_name="test",
        )


def test_provider_parser_rejects_unknown_section_ids() -> None:
    request = _request(language=PaperLanguage.ENGLISH, template_id="generic-en")
    raw = json.dumps({"sections": [{"id": "../outside", "content": "unsafe"}]})

    with pytest.raises(ProviderError, match="未知のセクション"):
        parse_provider_text(request, raw, provider_name="test")


def test_fallback_provider_handles_malformed_generation_schema() -> None:
    provider = FallbackProvider(MockProvider(response="not-json"), RuleBasedProvider())

    response = asyncio.run(provider.generate(_request(summary="supplied fact")))

    assert response.fallback_used
    assert response.provider_name == "rule-based"
    assert "有効なJSON" in response.warnings[0]
