"""Fact-preserving rule-based section generation and provider orchestration."""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from paper_tools.schemas import (
    ContentOrigin,
    ContentSegment,
    GeneratedSection,
    GenerationRequest,
    GenerationResponse,
    OutlineSection,
    PaperLanguage,
    PaperSpec,
)
from paper_tools.services.planning import PaperPlanningService
from paper_tools.services.templates import TemplateService

if TYPE_CHECKING:
    from paper_tools.providers.base import TextGenerationProvider


_SECTION_FIELDS: dict[str, tuple[str, ...]] = {
    "abstract": ("summary", "objective", "method", "results"),
    "introduction": ("background", "problem", "objective", "novelty", "key_message"),
    "related-work": (),
    "method": ("method", "system_design"),
    "proposed-approach": ("method", "novelty", "system_design"),
    "system-design": ("system_design", "method"),
    "control-method": ("method",),
    "experiments": ("experimental_conditions", "metrics"),
    "experimental-setup": ("experimental_conditions", "system_design"),
    "evaluation": ("metrics", "experimental_conditions", "results"),
    "evaluation-metrics": ("metrics",),
    "results": ("results",),
    "results-discussion": ("results", "discussion", "limitations"),
    "discussion": ("discussion", "limitations"),
    "limitations": ("limitations",),
    "conclusion": ("conclusion", "future_work"),
    "search-strategy": ("method",),
    "classification": ("results", "notes"),
    "comparison": ("results", "discussion"),
    "research-gaps": ("problem", "future_work"),
    "problem": ("problem",),
    "objectives": ("objective",),
    "proposed-method": ("method", "novelty"),
    "research-plan": ("experimental_conditions", "method"),
    "expected-results": ("achievement", "metrics"),
    "risks": ("limitations",),
    "schedule": (),
    "objective": ("objective",),
    "equipment": ("system_design",),
    "conditions": ("experimental_conditions",),
    "procedure": ("method",),
    "analysis": ("discussion",),
    "problems": ("limitations", "problem"),
}

_LABELS_JA: dict[str, str] = {
    "summary": "概要",
    "notes": "研究メモ",
    "achievement": "実現したこと",
    "key_message": "主要な主張",
    "background": "背景",
    "problem": "課題",
    "objective": "研究目的",
    "novelty": "新規性",
    "method": "手法",
    "system_design": "システム構成",
    "experimental_conditions": "実験条件",
    "metrics": "評価指標",
    "results": "入力済みの結果",
    "discussion": "考察メモ",
    "limitations": "制約・限界",
    "conclusion": "結論メモ",
    "future_work": "今後の課題",
}

_LABELS_EN: dict[str, str] = {
    "summary": "Summary",
    "notes": "Research notes",
    "achievement": "Reported achievement",
    "key_message": "Key message",
    "background": "Background",
    "problem": "Problem",
    "objective": "Research objective",
    "novelty": "Novelty stated by the author",
    "method": "Method",
    "system_design": "System design",
    "experimental_conditions": "Experimental conditions",
    "metrics": "Evaluation metrics",
    "results": "User-supplied results",
    "discussion": "Discussion notes",
    "limitations": "Limitations",
    "conclusion": "Conclusion notes",
    "future_work": "Future work",
}


def generate_rule_based_response(
    request: GenerationRequest,
    *,
    planning: PaperPlanningService | None = None,
    templates: TemplateService | None = None,
) -> GenerationResponse:
    """Generate a deterministic draft containing only user-supplied facts."""

    template_service = templates or TemplateService()
    planner = planning or PaperPlanningService(template_service)
    outline = request.outline or planner.plan(request.paper_spec)
    sections_to_generate = outline.sections
    if request.target_section is not None:
        sections_to_generate = [
            section for section in outline.sections if section.id == request.target_section
        ]
        if not sections_to_generate:
            raise ValueError(f"unknown target section: {request.target_section}")

    generated = [_draft_section(request.paper_spec, section) for section in sections_to_generate]
    missing = [
        segment.text
        for section in generated
        for segment in section.segments
        if segment.origin is ContentOrigin.PLACEHOLDER
    ]
    manifest = template_service.get_template(outline.template_id)
    existing_asset_text = " ".join(
        f"{asset.name} {asset.description} {asset.purpose}" for asset in request.paper_spec.assets
    ).lower()
    suggested_figures = [
        item for item in manifest.recommended_figures if item.lower() not in existing_asset_text
    ]
    suggested_tables = [
        item for item in manifest.recommended_tables if item.lower() not in existing_asset_text
    ]
    suggested_data = [
        item for item in manifest.recommended_data if item.lower() not in existing_asset_text
    ]
    return GenerationResponse(
        outline=outline,
        sections=generated,
        missing_information=_unique(missing),
        suggested_figures=suggested_figures,
        suggested_tables=suggested_tables,
        suggested_data=suggested_data,
        provider_name="rule-based",
    )


def _draft_section(spec: PaperSpec, outline: OutlineSection) -> GeneratedSection:
    if outline.id == "references":
        return _reference_section(spec, outline)
    fields = _SECTION_FIELDS.get(outline.id, ("summary", "notes"))
    segments: list[ContentSegment] = []
    for field in fields:
        value = getattr(spec, field)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if not item:
                continue
            label = (_LABELS_JA if spec.language is PaperLanguage.JAPANESE else _LABELS_EN)[field]
            separator = "：" if spec.language is PaperLanguage.JAPANESE else ": "
            segments.append(
                ContentSegment(text=f"{label}{separator}", origin=ContentOrigin.GENERATED)
            )
            segments.append(
                ContentSegment(text=str(item), origin=ContentOrigin.USER, source_field=field)
            )
            segments.append(ContentSegment(text="\n\n", origin=ContentOrigin.GENERATED))
    if not segments:
        segments.append(_missing_placeholder(spec, outline.id))
    elif (
        outline.id in {"abstract", "results", "results-discussion", "evaluation"}
        and not spec.results
    ):
        segments.append(_missing_placeholder(spec, "results"))
    # Instructions are retained for regeneration but are not facts and are not copied into prose.
    instruction_applied = outline.instruction or ""
    content = "".join(segment.text for segment in segments).strip()
    return GeneratedSection(
        id=outline.id,
        title=outline.title,
        content=content,
        segments=segments,
        instruction_applied=instruction_applied,
    )


def _reference_section(spec: PaperSpec, outline: OutlineSection) -> GeneratedSection:
    segments: list[ContentSegment] = []
    for reference in spec.references:
        authors = ", ".join(reference.authors)
        pieces = [piece for piece in [authors, reference.title, reference.venue] if piece]
        if reference.year is not None:
            pieces.append(str(reference.year))
        segments.append(
            ContentSegment(
                text=f"[{reference.key}] " + ". ".join(pieces) + ".\n",
                origin=ContentOrigin.USER,
                source_field="references",
            )
        )
    if not segments:
        text = (
            "[CITATION NEEDED: 関連研究を裏付ける参考文献を登録]"
            if spec.language is PaperLanguage.JAPANESE
            else "[CITATION NEEDED: Add sources supporting the related work]"
        )
        segments.append(ContentSegment(text=text, origin=ContentOrigin.PLACEHOLDER))
    return GeneratedSection(
        id=outline.id,
        title=outline.title,
        content="".join(segment.text for segment in segments).strip(),
        segments=segments,
        instruction_applied=outline.instruction,
    )


def _missing_placeholder(spec: PaperSpec, section_id: str) -> ContentSegment:
    result_sections = {"results", "results-discussion", "evaluation", "expected-results"}
    figure_sections = {"system-design"}
    if section_id in result_sections:
        marker = "DATA NEEDED"
        message = (
            "測定結果と評価条件を記載"
            if spec.language is PaperLanguage.JAPANESE
            else "Add measured results and evaluation conditions"
        )
    elif section_id in figure_sections:
        marker = "FIGURE NEEDED"
        message = (
            "システム構成を説明する図を追加"
            if spec.language is PaperLanguage.JAPANESE
            else "Add a figure describing the system architecture"
        )
    elif section_id == "related-work":
        marker = "CITATION NEEDED"
        message = (
            "関連研究を裏付ける参考文献を登録"
            if spec.language is PaperLanguage.JAPANESE
            else "Add sources supporting the related work"
        )
    else:
        marker = "TODO"
        message = (
            "このセクションに必要な情報を入力"
            if spec.language is PaperLanguage.JAPANESE
            else "Provide information for this section"
        )
    return ContentSegment(text=f"[{marker}: {message}]", origin=ContentOrigin.PLACEHOLDER)


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


class SectionGenerationService:
    """Thin application boundary around a swappable provider."""

    def __init__(self, provider: TextGenerationProvider) -> None:
        self.provider = provider

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        return await self.provider.generate(request)


class PaperGenerationService(SectionGenerationService):
    """Alias expressing whole-paper use at composition roots."""
