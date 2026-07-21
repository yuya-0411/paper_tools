from __future__ import annotations

from pathlib import Path

import pytest

from paper_tools.schemas import PaperLanguage, PaperSpec
from paper_tools.services.planning import PaperPlanningService
from paper_tools.services.templates import (
    TemplateNotFoundError,
    TemplateService,
    TemplateValidationError,
)

EXPECTED_IDS = {
    "generic-ja",
    "generic-en",
    "engineering-two-column",
    "robotics-experiment",
    "short-paper",
    "literature-review",
    "research-proposal",
    "experiment-report",
}


def test_all_eight_original_templates_are_discoverable() -> None:
    templates = TemplateService().list_templates()

    assert {template.id for template in templates} == EXPECTED_IDS
    assert all(template.original for template in templates)
    assert all(template.sections for template in templates)


@pytest.mark.parametrize("template_id", sorted(EXPECTED_IDS))
def test_every_template_renders_split_section_includes(template_id: str) -> None:
    source = TemplateService().render(
        template_id,
        {
            "title": "Safe title",
            "authors": [],
            "author_placeholder": "[TODO: author]",
            "abstract": "[TODO: abstract]",
            "has_abstract": True,
            "keywords": ["test"],
            "sections": [{"id": "conclusion"}],
            "citation_keys": ["Known2026"],
            "language": "en",
            "english_variant": "american",
            "english_region": "US",
            "abstract_label": "Abstract",
            "summary_label": "Summary",
            "keywords_label": "Keywords",
            "contents_label": "Contents",
            "author_separator": "; ",
            "keyword_separator": ", ",
            "manifest": {},
        },
    )

    assert "Safe title" in source
    assert "// paper-tools-citations: @Known2026" in source
    assert '#include "sections/abstract.typ"' in source
    assert '#include "sections/conclusion.typ"' in source
    if template_id == "engineering-two-column":
        assert '#set math.equation(numbering: "(1)")' in source
    assert source.endswith("\n")


def test_template_id_cannot_traverse_outside_root() -> None:
    with pytest.raises(TemplateNotFoundError):
        TemplateService().get_template("../generic-ja")


def test_manifest_id_must_match_directory(tmp_path: Path) -> None:
    directory = tmp_path / "safe-id"
    directory.mkdir()
    (directory / "manifest.yml").write_text(
        "id: another-id\nname: x\ndescription: x\nlanguages: [ja]\n"
        "document_types: [x]\nsections: [{id: x, title_ja: x, title_en: x}]\n"
        "version: 1.0.0\n",
        encoding="utf-8",
    )

    with pytest.raises(TemplateValidationError, match="does not match"):
        TemplateService(tmp_path).get_template("safe-id")


def test_planner_rejects_unsupported_language() -> None:
    spec = PaperSpec(language=PaperLanguage.ENGLISH, template_id="generic-ja")

    # Explicit selection is intentional and therefore validated rather than auto-switched.
    with pytest.raises(ValueError, match="does not support"):
        PaperPlanningService().plan(spec, "generic-ja")


def test_english_default_is_switched_to_generic_en() -> None:
    outline = PaperPlanningService().plan(PaperSpec(language=PaperLanguage.ENGLISH))

    assert outline.template_id == "generic-en"
    assert outline.sections[0].title == "Abstract"
