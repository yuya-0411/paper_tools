"""Deterministic paper outline planning."""

from __future__ import annotations

from paper_tools.schemas import OutlineSection, PaperLanguage, PaperOutline, PaperSpec
from paper_tools.services.templates import TemplateService


class PaperPlanningService:
    """Build an outline from a validated manifest without generating facts."""

    def __init__(self, templates: TemplateService | None = None) -> None:
        self.templates = templates or TemplateService()

    def plan(self, spec: PaperSpec, template_id: str | None = None) -> PaperOutline:
        selected_id = self._select_template(spec, template_id)
        manifest = self.templates.get_template(selected_id)
        if spec.language.value not in manifest.languages:
            raise ValueError(
                f"template '{selected_id}' does not support language '{spec.language.value}'"
            )
        sections = [
            OutlineSection(
                id=section.id,
                title=(
                    section.title_ja
                    if spec.language is PaperLanguage.JAPANESE
                    else section.title_en
                ),
                order=index,
                purpose=(
                    section.purpose_ja
                    if spec.language is PaperLanguage.JAPANESE
                    else section.purpose_en
                ),
                instruction=spec.section_instructions.get(section.id, ""),
            )
            for index, section in enumerate(manifest.sections)
        ]
        title = spec.title or (
            "[TODO: 論文タイトルを入力]"
            if spec.language is PaperLanguage.JAPANESE
            else "[TODO: Enter the paper title]"
        )
        return PaperOutline(
            title=title,
            sections=sections,
            template_id=selected_id,
            language=spec.language.value,
        )

    @staticmethod
    def _select_template(spec: PaperSpec, template_id: str | None) -> str:
        if template_id:
            return template_id
        if spec.language is PaperLanguage.ENGLISH and spec.template_id == "generic-ja":
            return "generic-en"
        return spec.template_id
