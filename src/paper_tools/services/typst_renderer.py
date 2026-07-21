"""Render escaped generation results through package-owned Typst templates."""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from paper_tools.exceptions import ValidationError
from paper_tools.schemas import (
    GeneratedSection,
    GenerationResponse,
    PaperLanguage,
    PaperSpec,
    TypstDocument,
)
from paper_tools.services.templates import TemplateService
from paper_tools.utils.path_safety import atomic_write_bytes, resolve_within

_SAFE_SECTION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_CITATION_RE = re.compile(r"@([A-Za-z0-9_.:+/-]+)")
_CITATION_KEY_RE = re.compile(r"^[A-Za-z0-9_.:+/-]+$")
_TYPST_REFERENCE_SHORTHAND_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]*$")
_CITATION_TRAILING_PUNCTUATION = ".,;:!?，．、。"
_TYPST_LITERAL_AT = r"\u{0040}"
_TYPST_SPECIAL = frozenset("\\#[]$*_`<>=+-")


def escape_typst(value: str) -> str:
    """Escape user/provider text for insertion into Typst markup content blocks."""

    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    escaped: list[str] = []
    for character in normalized:
        if character == "@":
            # ``\\@literal`` is safe Typst, but a lexical citation-usage scan still
            # sees ``@literal``.  Render the glyph without retaining a raw at-sign so
            # escaped text and usage analysis have the same meaning.
            escaped.append(_TYPST_LITERAL_AT)
        elif character in _TYPST_SPECIAL:
            escaped.append(f"\\{character}")
        else:
            escaped.append(character)
    return "".join(escaped)


class TypstRenderingService:
    def __init__(self, templates: TemplateService | None = None) -> None:
        self.templates = templates or TemplateService()

    def render(
        self,
        spec: PaperSpec,
        generated: GenerationResponse,
        *,
        template_id: str | None = None,
    ) -> TypstDocument:
        selected_id = template_id or generated.outline.template_id
        manifest = self.templates.get_template(selected_id)
        if spec.language.value not in manifest.languages:
            raise ValueError(
                f"template '{selected_id}' does not support language '{spec.language.value}'"
            )
        registered_citations = self._registered_citation_keys(spec)
        citation_usage: dict[str, str] = {}
        sections: list[GeneratedSection] = []
        for section in generated.sections:
            usage_target = {} if section.id == "references" and spec.references else citation_usage
            sections.append(
                self._escaped_section(section, spec, registered_citations, usage_target)
            )
        section_ids: set[str] = set()
        for section in sections:
            if section.id in section_ids:
                raise ValueError(f"duplicate section id: {section.id}")
            section_ids.add(section.id)
        abstract_section = next((section for section in sections if section.id == "abstract"), None)
        body_sections = [section for section in sections if section.id != "abstract"]
        has_reference_section = any(section.id == "references" for section in body_sections)
        title_placeholder = (
            "[TODO: 論文タイトルを入力]"
            if spec.language is PaperLanguage.JAPANESE
            else "[TODO: Enter the paper title]"
        )
        author_placeholder = (
            "[TODO: 著者情報を入力]"
            if spec.language is PaperLanguage.JAPANESE
            else "[TODO: Enter author information]"
        )
        keyword_placeholder = (
            "[TODO: キーワードを入力]"
            if spec.language is PaperLanguage.JAPANESE
            else "[TODO: Enter keywords]"
        )
        abstract_placeholder = escape_typst(
            "[TODO: 概要を入力]"
            if spec.language is PaperLanguage.JAPANESE
            else "[TODO: Enter the abstract]"
        )
        authors = [
            {
                "name": escape_typst(self._apply_style(author.name, spec)),
                "affiliation": escape_typst(self._apply_style(author.affiliation, spec)),
                "email": escape_typst(author.email),
            }
            for author in sorted(spec.authors, key=lambda item: item.order)
            if author.name
        ]
        context: dict[str, Any] = {
            "title": escape_typst(self._apply_style(spec.title or title_placeholder, spec)),
            "authors": authors,
            "author_placeholder": escape_typst(author_placeholder),
            "abstract": abstract_placeholder,
            "has_abstract": abstract_section is not None,
            "keywords": [
                escape_typst(self._apply_style(keyword, spec)) for keyword in spec.keywords
            ]
            or [escape_typst(keyword_placeholder)],
            # Section IDs have already passed ``_SAFE_SECTION_ID``.  Templates use
            # only these IDs to construct package-owned relative include paths.
            "sections": [{"id": section.id} for section in body_sections],
            # The current editor usage scanner reads ``main.typ``.  A trusted
            # comment records lexical candidates (including missing keys) so moving
            # prose to included files preserves both used and missing diagnostics.
            "citation_keys": list(citation_usage.values()),
            "language": spec.language.value,
            "english_variant": spec.english_variant.value,
            "english_region": (
                "GB"
                if spec.language is PaperLanguage.ENGLISH
                and spec.english_variant.value == "british"
                else "US"
                if spec.language is PaperLanguage.ENGLISH
                else ""
            ),
            "abstract_label": "概要" if spec.language is PaperLanguage.JAPANESE else "Abstract",
            "summary_label": "要約" if spec.language is PaperLanguage.JAPANESE else "Summary",
            "keywords_label": (
                "キーワード" if spec.language is PaperLanguage.JAPANESE else "Keywords"
            ),
            "contents_label": "目次" if spec.language is PaperLanguage.JAPANESE else "Contents",
            "author_separator": (
                "、"
                if spec.language is PaperLanguage.JAPANESE
                and spec.japanese_punctuation.value == "、。"
                else "，"
                if spec.language is PaperLanguage.JAPANESE
                else "; "
            ),
            "keyword_separator": (
                "、"
                if spec.language is PaperLanguage.JAPANESE
                and spec.japanese_punctuation.value == "、。"
                else "，"
                if spec.language is PaperLanguage.JAPANESE
                else ", "
            ),
            "manifest": manifest.model_dump(),
        }
        source = self.templates.render(selected_id, context).rstrip() + "\n"
        if spec.references and not has_reference_section:
            source = source.rstrip() + '\n\n#bibliography("references.yml")\n'
        files: dict[str, str] = {}
        for section in sections:
            relative_path = str(PurePosixPath("sections") / f"{section.id}.typ")
            if section.id == "abstract":
                # The abstract is included inside a template-owned summary block, so
                # its split file deliberately contains no top-level heading.
                files[relative_path] = f"{section.content or abstract_placeholder}\n"
            elif section.id == "references" and spec.references:
                # A registered bibliography is the canonical reference rendering.
                # Replacing generated prose here avoids a duplicate heading/list.
                files[relative_path] = '#bibliography("../references.yml")\n'
            else:
                files[relative_path] = f"= {section.title}\n\n{section.content}\n"
        files["main.typ"] = source
        return TypstDocument(
            source=source,
            template_id=selected_id,
            sections=sections,
            files=files,
        )

    def write_document(self, document: TypstDocument, project_dir: Path) -> list[Path]:
        """Write only validated relative document paths beneath ``project_dir``."""

        root = project_dir
        root.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        for relative_name, content in document.files.items():
            try:
                target = resolve_within(root, relative_name)
            except ValidationError as exc:
                raise ValueError(f"unsafe document path: {relative_name}") from exc
            target.parent.mkdir(parents=True, exist_ok=True)
            # Reject a pre-existing redirect and a redirect swapped in while the
            # parent directory was being created.
            try:
                target = resolve_within(root, relative_name)
            except ValidationError as exc:
                raise ValueError(f"unsafe document path: {relative_name}") from exc
            atomic_write_bytes(target, content.encode("utf-8"))
            written.append(target)
        return written

    @classmethod
    def _escaped_section(
        cls,
        section: GeneratedSection,
        spec: PaperSpec,
        registered_citations: Mapping[str, str],
        citation_usage: dict[str, str],
    ) -> GeneratedSection:
        if not _SAFE_SECTION_ID.fullmatch(section.id):
            raise ValueError(f"unsafe section id: {section.id}")
        return section.model_copy(
            update={
                "title": escape_typst(cls._apply_style(section.title, spec)),
                "content": cls._escape_prose_with_citations(
                    cls._apply_style(section.content, spec),
                    registered_citations,
                    citation_usage,
                ),
            }
        )

    @staticmethod
    def _registered_citation_keys(spec: PaperSpec) -> dict[str, str]:
        """Return keys recognized by the editor's lexical citation-usage parser."""

        registered: dict[str, str] = {}
        for reference in spec.references:
            key = reference.key
            if not _CITATION_KEY_RE.fullmatch(key):
                continue
            # The usage parser treats terminal punctuation as prose punctuation,
            # not as part of a key.  Such a stored key cannot be referenced by this
            # shorthand without ambiguity and therefore remains literal text.
            if key.rstrip(_CITATION_TRAILING_PUNCTUATION) != key:
                continue
            registered.setdefault(key.casefold(), key)
        return registered

    @classmethod
    def _escape_prose_with_citations(
        cls,
        value: str,
        registered_citations: Mapping[str, str],
        citation_usage: dict[str, str],
    ) -> str:
        """Escape prose while preserving only citations backed by ``PaperSpec``."""

        normalized = value.replace("\r\n", "\n").replace("\r", "\n")
        rendered: list[str] = []
        cursor = 0
        for match in _CITATION_RE.finditer(normalized):
            rendered.append(escape_typst(normalized[cursor : match.start()]))
            token = match.group(1)
            candidate = token.rstrip(_CITATION_TRAILING_PUNCTUATION)
            canonical = registered_citations.get(candidate.casefold()) if candidate else None
            if candidate:
                usage_key = canonical or candidate
                citation_usage.setdefault(usage_key.casefold(), usage_key)
            if canonical is None:
                rendered.append(escape_typst(match.group(0)))
            else:
                rendered.append(cls._typst_citation(canonical))
                rendered.append(escape_typst(token[len(candidate) :]))
            cursor = match.end()
        rendered.append(escape_typst(normalized[cursor:]))
        return "".join(rendered)

    @staticmethod
    def _typst_citation(key: str) -> str:
        if _TYPST_REFERENCE_SHORTHAND_RE.fullmatch(key):
            return f"@{key}"
        # The label constructor safely supports keys (such as ``a/b`` or ``a+b``)
        # that the editor recognizes but Typst's dedicated ``@key`` syntax does not.
        return f'#cite(label("{key}"))'

    @staticmethod
    def _apply_style(value: str, spec: PaperSpec) -> str:
        if spec.language is not PaperLanguage.JAPANESE:
            return value
        if spec.japanese_punctuation.value == "、。":
            return value.replace("，", "、").replace("．", "。")
        return value.replace("、", "，").replace("。", "．")
