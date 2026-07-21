"""Project aggregate CRUD, autosave, and section version history."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from paper_tools.exceptions import ConflictError, NotFoundError, ValidationError
from paper_tools.models import (
    Author,
    GenerationInstruction,
    Project,
    Section,
    SectionVersion,
    utc_now,
)
from paper_tools.models import (
    PaperSpec as StoredPaperSpec,
)
from paper_tools.repositories import ProjectRepository, SectionRepository

_SECTION_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,158}$")
_PROJECT_FIELDS = {
    "name",
    "title",
    "language",
    "paper_type",
    "research_field",
    "template_id",
    "page_target",
    "audience",
    "venue_note",
    "status",
    "wizard_step",
    "typst_source",
    "pdf_relative_path",
}
_SPEC_FIELDS = {
    "summary",
    "notes",
    "achievement",
    "key_message",
    "background",
    "problem",
    "objective",
    "novelty",
    "method",
    "system_design",
    "experimental_conditions",
    "metrics",
    "results",
    "discussion",
    "limitations",
    "conclusion",
    "future_work",
    "keywords",
    "overall_instruction",
    "section_instructions",
    "selected_presets",
    "japanese_punctuation",
    "english_variant",
}


@dataclass(frozen=True, slots=True)
class AutosaveResult:
    """A no-op is successful and distinguishable from a database write."""

    saved: bool
    changed_fields: tuple[str, ...] = ()
    version_id: str | None = None


def content_digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _mapping(value: Mapping[str, Any] | object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(mode="python")
        if isinstance(dumped, Mapping):
            return dumped
    raise ValidationError("入力データの形式が不正です．")


def _list_value(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    if isinstance(value, Iterable):
        return [str(item).strip() for item in value if str(item).strip()]
    raise ValidationError("リスト形式の入力が不正です．")


class ProjectService:
    """Coordinate changes to a Project aggregate in one caller-owned transaction."""

    def __init__(self, session: Session) -> None:
        self.session = session
        self.projects = ProjectRepository(session)
        self.sections = SectionRepository(session)

    def create_project(
        self,
        *,
        name: str,
        title: str = "",
        language: str = "ja",
        paper_type: str = "research-paper",
        research_field: str = "",
        template_id: str = "generic-ja",
        page_target: int | None = None,
        audience: str = "",
        venue_note: str = "",
        wizard_step: int = 1,
        paper_spec: Mapping[str, Any] | object | None = None,
        authors: Iterable[Mapping[str, Any] | object] = (),
        sections: Iterable[Mapping[str, Any] | object] = (),
    ) -> Project:
        clean_name = name.strip()
        if not clean_name:
            raise ValidationError("プロジェクト名を入力してください．")
        self._validate_project_values(language, page_target, wizard_step)
        project = Project(
            name=clean_name,
            title=title.strip(),
            language=language,
            paper_type=paper_type.strip() or "research-paper",
            research_field=research_field.strip(),
            template_id=template_id.strip() or ("generic-ja" if language == "ja" else "generic-en"),
            page_target=page_target,
            audience=audience.strip(),
            venue_note=venue_note.strip(),
            wizard_step=wizard_step,
        )
        self.session.add(project)
        self.session.flush()

        spec_values = dict(_mapping(paper_spec)) if paper_spec is not None else {}
        project.paper_spec = self._new_stored_spec(project.id, spec_values)
        self.session.flush()
        self.replace_authors(project.id, authors)
        for section_data in sections:
            data = _mapping(section_data)
            self.create_section(
                project.id,
                slug=str(data.get("slug", data.get("id", ""))),
                title=str(data.get("title", "")),
                position=int(data.get("position", data.get("order", 0))),
                content=str(data.get("content", "")),
                instruction=str(data.get("instruction", "")),
                generated=bool(data.get("generated", False)),
            )
        self.session.flush()
        return project

    def get_project(self, project_id: str, *, aggregate: bool = True) -> Project:
        return (
            self.projects.get_aggregate(project_id)
            if aggregate
            else self.projects.get_required(project_id)
        )

    def list_projects(self, *, limit: int | None = None) -> Sequence[Project]:
        if limit is not None and limit < 1:
            raise ValidationError("取得件数は1以上で指定してください．")
        return self.projects.list_recent(limit=limit)

    def update_project(
        self,
        project_id: str,
        values: Mapping[str, Any] | None = None,
        **changes: Any,
    ) -> Project:
        merged = dict(values or {})
        merged.update(changes)
        unknown = set(merged) - _PROJECT_FIELDS - _SPEC_FIELDS
        if unknown:
            raise ValidationError(f"未対応の項目です: {', '.join(sorted(unknown))}")
        project = self.projects.get_required(project_id)
        project_values = {key: value for key, value in merged.items() if key in _PROJECT_FIELDS}
        spec_values = {key: value for key, value in merged.items() if key in _SPEC_FIELDS}
        if (
            "language" in project_values
            or "page_target" in project_values
            or "wizard_step" in project_values
        ):
            self._validate_project_values(
                str(project_values.get("language", project.language)),
                project_values.get("page_target", project.page_target),
                int(project_values.get("wizard_step", project.wizard_step)),
            )
        for field, value in project_values.items():
            if field in {
                "name",
                "title",
                "paper_type",
                "research_field",
                "template_id",
                "audience",
                "venue_note",
            }:
                value = str(value).strip()
            if field == "name" and not value:
                raise ValidationError("プロジェクト名を入力してください．")
            setattr(project, field, value)
        if spec_values:
            self.update_paper_spec(project_id, spec_values)
        project.updated_at = utc_now()
        self.session.flush()
        return project

    def delete_project(self, project_id: str) -> None:
        """Delete database records; project files are retained for safer recovery."""

        project = self.projects.get_required(project_id)
        self.projects.delete(project)

    def update_paper_spec(
        self,
        project_id: str,
        values: Mapping[str, Any],
    ) -> StoredPaperSpec:
        unknown = set(values) - _SPEC_FIELDS
        if unknown:
            raise ValidationError(f"未対応の論文情報です: {', '.join(sorted(unknown))}")
        project = self.projects.get_required(project_id)
        stored = project.paper_spec
        if stored is None:
            stored = self._new_stored_spec(project_id, {})
            project.paper_spec = stored
        for field, raw_value in values.items():
            value = self._normalize_spec_value(field, raw_value)
            setattr(stored, field, value)
        project.updated_at = utc_now()
        self.session.flush()
        return stored

    def replace_authors(
        self,
        project_id: str,
        author_values: Iterable[Mapping[str, Any] | object],
    ) -> list[Author]:
        project = self.projects.get_required(project_id)
        authors: list[Author] = []
        for index, raw_author in enumerate(author_values):
            data = _mapping(raw_author)
            position = int(data.get("position", data.get("order", index)))
            if position < 0:
                raise ValidationError("著者順は0以上で指定してください．")
            authors.append(
                Author(
                    project_id=project_id,
                    name=str(data.get("name", "")).strip(),
                    affiliation=str(data.get("affiliation", "")).strip(),
                    email=str(data.get("email", "")).strip(),
                    orcid=str(data.get("orcid", "")).strip(),
                    corresponding=bool(
                        data.get("corresponding", data.get("is_corresponding", False))
                    ),
                    position=position,
                )
            )
        positions = [author.position for author in authors]
        if len(positions) != len(set(positions)):
            raise ConflictError("著者順が重複しています．")
        self.projects.replace_authors(project, authors)
        project.updated_at = utc_now()
        return authors

    def create_section(
        self,
        project_id: str,
        *,
        slug: str,
        title: str,
        position: int,
        content: str = "",
        instruction: str = "",
        generated: bool = False,
    ) -> Section:
        self.projects.get_required(project_id)
        normalized_slug = slug.strip().lower().replace("_", "-")
        if not _SECTION_SLUG_RE.fullmatch(normalized_slug):
            raise ValidationError("セクションIDは英小文字，数字，ハイフンで指定してください．")
        if position < 0:
            raise ValidationError("セクション順は0以上で指定してください．")
        if self.sections.by_slug(project_id, normalized_slug) is not None:
            raise ConflictError("同じセクションIDが既に存在します．")
        occupied = self.session.scalar(
            select(func.count())
            .select_from(Section)
            .where(Section.project_id == project_id, Section.position == position)
        )
        if occupied:
            raise ConflictError("セクション順が重複しています．")
        section = Section(
            project_id=project_id,
            slug=normalized_slug,
            title=title.strip() or normalized_slug,
            position=position,
            content=content,
            instruction=instruction,
            content_hash=content_digest(content),
            generated=generated,
        )
        self.sections.add(section)
        if content:
            self.snapshot_section(section, operation="created")
        return section

    def save_section(
        self,
        project_id: str,
        slug: str,
        *,
        content: str,
        instruction: str | None = None,
        operation: str = "manual-save",
        provider: str | None = None,
    ) -> AutosaveResult:
        section = self.sections.required_by_slug(project_id, slug)
        project = self.projects.get_required(project_id)
        stored_instructions = (
            dict(project.paper_spec.section_instructions) if project.paper_spec is not None else {}
        )
        normalized_instruction = instruction if instruction is not None else section.instruction
        expected_stored_instruction = stored_instructions.get(slug, "")
        instruction_needs_sync = (
            instruction is not None and expected_stored_instruction != normalized_instruction
        )
        content_changed = section.content != content
        section_instruction_changed = (
            instruction is not None and section.instruction != normalized_instruction
        )
        if not content_changed and not section_instruction_changed and not instruction_needs_sync:
            return AutosaveResult(saved=False)
        section.content = content
        section.content_hash = content_digest(content)
        if instruction is not None:
            section.instruction = normalized_instruction
            if normalized_instruction:
                stored_instructions[slug] = normalized_instruction
            else:
                stored_instructions.pop(slug, None)
            if project.paper_spec is None:
                project.paper_spec = self._new_stored_spec(project_id, {})
            project.paper_spec.section_instructions = stored_instructions
        section.updated_at = utc_now()
        version = self.snapshot_section(
            section,
            operation=operation,
            provider=provider,
            instruction=section.instruction,
        )
        project.updated_at = utc_now()
        self.session.flush()
        changed: list[str] = []
        if content_changed:
            changed.append("content")
        if section_instruction_changed or instruction_needs_sync:
            changed.append("instruction")
        return AutosaveResult(
            saved=True,
            changed_fields=tuple(changed),
            version_id=version.id if version is not None else None,
        )

    def autosave_section(
        self,
        project_id: str,
        slug: str,
        *,
        content: str,
        instruction: str | None = None,
    ) -> AutosaveResult:
        return self.save_section(
            project_id,
            slug,
            content=content,
            instruction=instruction,
            operation="autosave",
        )

    def snapshot_section(
        self,
        section: Section,
        *,
        operation: str,
        provider: str | None = None,
        instruction: str | None = None,
    ) -> SectionVersion | None:
        """Record a content state once; repeated snapshots of identical text are no-ops."""

        digest = content_digest(section.content)
        latest = self.sections.latest_version(section.id)
        if latest is not None and latest.content_hash == digest:
            return None
        version = SectionVersion(
            section_id=section.id,
            content=section.content,
            instruction=section.instruction if instruction is None else instruction,
            operation=operation.strip() or "save",
            provider=provider,
            content_hash=digest,
        )
        self.session.add(version)
        self.session.flush()
        return version

    def list_section_versions(self, project_id: str, slug: str) -> Sequence[SectionVersion]:
        section = self.sections.required_by_slug(project_id, slug)
        return self.sections.versions(section.id)

    def restore_section_version(
        self,
        project_id: str,
        slug: str,
        version_id: str,
    ) -> AutosaveResult:
        section = self.sections.required_by_slug(project_id, slug)
        version = self.session.get(SectionVersion, version_id)
        if version is None or version.section_id != section.id:
            raise NotFoundError("復元する版が見つかりません．")
        return self.save_section(
            project_id,
            slug,
            content=version.content,
            instruction=version.instruction,
            operation=f"restore:{version.id}",
            provider=version.provider,
        )

    def autosave_project(
        self,
        project_id: str,
        values: Mapping[str, Any],
    ) -> AutosaveResult:
        """Persist changed form/source fields only, preventing duplicate writes."""

        unknown = set(values) - _PROJECT_FIELDS - _SPEC_FIELDS
        if unknown:
            raise ValidationError(f"未対応の自動保存項目です: {', '.join(sorted(unknown))}")
        project = self.projects.get_required(project_id)
        stored = project.paper_spec
        if stored is None:
            stored = self._new_stored_spec(project_id, {})
            project.paper_spec = stored
            self.session.flush()
        prospective_language = str(values.get("language", project.language))
        prospective_page_target = values.get("page_target", project.page_target)
        prospective_wizard_step = int(values.get("wizard_step", project.wizard_step))
        self._validate_project_values(
            prospective_language,
            prospective_page_target,
            prospective_wizard_step,
        )
        changed: list[str] = []
        for field, raw_value in values.items():
            target: Project | StoredPaperSpec = project if field in _PROJECT_FIELDS else stored
            value = (
                self._normalize_spec_value(field, raw_value) if field in _SPEC_FIELDS else raw_value
            )
            if field in {
                "name",
                "title",
                "paper_type",
                "research_field",
                "template_id",
                "audience",
                "venue_note",
            }:
                value = str(value).strip()
            if field == "name" and not value:
                raise ValidationError("プロジェクト名を入力してください．")
            if getattr(target, field) != value:
                setattr(target, field, value)
                changed.append(field)
        if not changed:
            return AutosaveResult(saved=False)
        project.updated_at = utc_now()
        self.session.flush()
        return AutosaveResult(saved=True, changed_fields=tuple(changed))

    def set_instruction(
        self,
        project_id: str,
        *,
        instruction: str,
        section_slug: str | None = None,
        presets: Iterable[str] = (),
    ) -> GenerationInstruction:
        project = self.projects.get_required(project_id)
        section = self.sections.required_by_slug(project_id, section_slug) if section_slug else None
        record = GenerationInstruction(
            project_id=project.id,
            section_id=section.id if section else None,
            scope="section" if section else "project",
            instruction=instruction.strip(),
            presets=[preset.strip() for preset in presets if preset.strip()],
        )
        self.session.add(record)
        if section is not None:
            section.instruction = record.instruction
        elif project.paper_spec is not None:
            project.paper_spec.overall_instruction = record.instruction
            project.paper_spec.selected_presets = list(record.presets)
        project.updated_at = utc_now()
        self.session.flush()
        return record

    def to_paper_spec(self, project_id: str) -> Any:
        """Build the provider-facing Pydantic PaperSpec without fabricating data."""

        from paper_tools.schemas.paper import (  # local import avoids ORM/schema cycles
            AssetSpec,
            AuthorSpec,
            PaperSpec,
            ReferenceSpec,
        )

        project = self.projects.get_aggregate(project_id)
        stored = project.paper_spec
        if stored is None:
            stored = self._new_stored_spec(project.id, {})
            project.paper_spec = stored
            self.session.flush()
        spec_values = {
            field: getattr(stored, field) for field in _SPEC_FIELDS if field != "selected_presets"
        }
        return PaperSpec(
            title=project.title,
            language=project.language,
            paper_type=project.paper_type,
            research_field=project.research_field,
            template_id=project.template_id,
            page_target=project.page_target,
            audience=project.audience,
            venue_note=project.venue_note,
            authors=[
                AuthorSpec(
                    name=author.name,
                    affiliation=author.affiliation,
                    email=author.email,
                    orcid=author.orcid,
                    corresponding=author.corresponding,
                    order=author.position,
                )
                for author in project.authors
            ],
            references=[
                ReferenceSpec(
                    key=reference.citation_key,
                    title=reference.title,
                    authors=list(reference.authors),
                    year=reference.year,
                    venue=reference.venue,
                    doi=reference.doi,
                    url=reference.url,
                )
                for reference in project.references
            ],
            assets=[
                AssetSpec(
                    kind=asset.kind,
                    name=asset.display_name,
                    description=asset.description,
                    purpose=asset.purpose,
                    target_section=asset.target_section,
                    source=asset.source,
                    is_original=asset.is_original,
                    relative_path=asset.relative_path,
                )
                for asset in project.assets
            ],
            **spec_values,
        )

    @staticmethod
    def _validate_project_values(language: str, page_target: Any, wizard_step: int) -> None:
        if language not in {"ja", "en"}:
            raise ValidationError("言語は ja または en を指定してください．")
        if page_target is not None and not 1 <= int(page_target) <= 1000:
            raise ValidationError("ページ数は1から1000で指定してください．")
        if not 1 <= wizard_step <= 5:
            raise ValidationError("作成ステップは1から5で指定してください．")

    @staticmethod
    def _normalize_spec_value(field: str, value: Any) -> Any:
        if field in {"notes", "keywords", "selected_presets"}:
            return _list_value(value)
        if field == "section_instructions":
            if not isinstance(value, Mapping):
                raise ValidationError("セクション指示は辞書形式で指定してください．")
            return {
                str(key).strip(): str(instruction).strip()
                for key, instruction in value.items()
                if str(key).strip() and str(instruction).strip()
            }
        return str(value).strip() if isinstance(value, str) else value

    def _new_stored_spec(
        self,
        project_id: str,
        values: Mapping[str, Any],
    ) -> StoredPaperSpec:
        unknown = (
            set(values)
            - _SPEC_FIELDS
            - {
                "title",
                "language",
                "paper_type",
                "research_field",
                "template_id",
                "page_target",
                "audience",
                "venue_note",
                "authors",
                "references",
                "assets",
            }
        )
        if unknown:
            raise ValidationError(f"未対応の論文情報です: {', '.join(sorted(unknown))}")
        normalized = {
            key: self._normalize_spec_value(key, value)
            for key, value in values.items()
            if key in _SPEC_FIELDS
        }
        return StoredPaperSpec(project_id=project_id, **normalized)


__all__ = ["AutosaveResult", "ProjectService", "content_digest"]
