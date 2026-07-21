from __future__ import annotations

import asyncio

import pytest

from paper_tools.providers import MockProvider, RuleBasedProvider
from paper_tools.schemas import (
    ContentOrigin,
    GenerationRequest,
    PaperLanguage,
    PaperSpec,
    ReferenceSpec,
)
from paper_tools.services.generation import SectionGenerationService, generate_rule_based_response
from paper_tools.services.planning import PaperPlanningService


def _complete_spec(**changes: object) -> PaperSpec:
    values: dict[str, object] = {
        "title": "安全な生成",
        "objective": "入力情報だけを用いて原稿案を作成する",
        "background": "論文作成には構造化が必要である",
        "novelty": "入力事実と生成文の由来を区別する",
        "method": "決定論的な規則で入力を節へ配置する",
        "experimental_conditions": "同一入力で繰り返し確認する",
        "metrics": "出力一致率",
        "results": "確認した結果は一致した",
        "discussion": "決定論的な出力を確認した",
        "conclusion": "入力範囲で原稿案を生成した",
        "keywords": ["論文", "生成"],
    }
    values.update(changes)
    return PaperSpec.model_validate(values)


def test_paper_spec_normalizes_lists_and_whitespace() -> None:
    spec = PaperSpec(title="  title  ", keywords="a, b, a", notes=(" x ", "x", ""))

    assert spec.title == "title"
    assert spec.keywords == ["a", "b"]
    assert spec.notes == ["x"]


def test_rule_based_generation_is_deterministic() -> None:
    request = GenerationRequest(paper_spec=_complete_spec())

    first = generate_rule_based_response(request)
    second = generate_rule_based_response(request)

    assert first == second


def test_rule_based_generation_preserves_user_origin() -> None:
    response = generate_rule_based_response(GenerationRequest(paper_spec=_complete_spec()))
    introduction = response.section("introduction")

    assert introduction is not None
    user_segments = [
        segment for segment in introduction.segments if segment.origin is ContentOrigin.USER
    ]
    assert any(segment.source_field == "objective" for segment in user_segments)


def test_missing_results_become_data_placeholder_not_fabrication() -> None:
    spec = _complete_spec(results="", discussion="")

    response = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    assert "[DATA NEEDED:" in response.section("results-discussion").content  # type: ignore[union-attr]
    assert not any(char.isdigit() for char in response.section("results-discussion").content)  # type: ignore[union-attr]


def test_no_reference_is_fabricated() -> None:
    response = generate_rule_based_response(GenerationRequest(paper_spec=_complete_spec()))

    references = response.section("references")
    assert references is not None
    assert references.content.startswith("[CITATION NEEDED:")


def test_only_registered_reference_is_rendered() -> None:
    reference = ReferenceSpec(
        key="known", title="A verified source", authors=["User Author"], year=2024
    )
    spec = _complete_spec(references=[reference])

    content = generate_rule_based_response(GenerationRequest(paper_spec=spec)).section("references")

    assert content is not None
    assert "A verified source" in content.content
    assert "User Author" in content.content


def test_english_generation_uses_english_placeholders() -> None:
    spec = PaperSpec(language=PaperLanguage.ENGLISH, template_id="generic-en", title="Draft")

    response = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    assert any("Provide information" in item for item in response.missing_information)
    assert response.outline.sections[0].title == "Abstract"


def test_simple_note_is_enough_to_create_outline_and_draft() -> None:
    spec = PaperSpec(summary="小型ロボットの設計メモ", notes=["安全停止を検討した"])

    response = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    assert response.outline.sections
    assert any("小型ロボット" in section.content for section in response.sections)


def test_target_section_limits_generation() -> None:
    request = GenerationRequest(paper_spec=_complete_spec(), target_section="method")

    response = generate_rule_based_response(request)

    assert [section.id for section in response.sections] == ["method"]


def test_unknown_target_section_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown target"):
        generate_rule_based_response(
            GenerationRequest(paper_spec=_complete_spec(), target_section="not-a-section")
        )


def test_section_instruction_is_retained_but_not_inserted_as_fact() -> None:
    spec = _complete_spec(section_instructions={"method": "数式を詳しく説明する"})

    method = generate_rule_based_response(GenerationRequest(paper_spec=spec)).section("method")

    assert method is not None
    assert method.instruction_applied == "数式を詳しく説明する"
    assert "数式を詳しく説明する" not in method.content


def test_planning_uses_each_template_manifest() -> None:
    planner = PaperPlanningService()
    for template_id in (
        "engineering-two-column",
        "robotics-experiment",
        "short-paper",
        "literature-review",
        "research-proposal",
        "experiment-report",
    ):
        outline = planner.plan(PaperSpec(template_id=template_id))
        assert outline.template_id == template_id
        assert outline.sections


def test_generation_service_accepts_swappable_provider() -> None:
    request = GenerationRequest(paper_spec=_complete_spec())
    expected = asyncio.run(RuleBasedProvider().generate(request))
    service = SectionGenerationService(MockProvider(expected))

    actual = asyncio.run(service.generate(request))

    assert actual == expected
