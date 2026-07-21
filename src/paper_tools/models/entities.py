"""SQLAlchemy 2 typed mappings for the paper_tools domain."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from paper_tools.models.base import Base, IdMixin, TimestampMixin
from paper_tools.models.enums import (
    AdviceCategory,
    AdviceSeverity,
    AssetKind,
    GenerationStatus,
)


class Project(Base, IdMixin, TimestampMixin):
    """Top-level aggregate for one paper and all locally stored artifacts."""

    __tablename__ = "projects"
    __table_args__ = (
        CheckConstraint("language IN ('ja', 'en')", name="ck_projects_language"),
        CheckConstraint("wizard_step BETWEEN 1 AND 5", name="ck_projects_wizard_step"),
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    language: Mapped[str] = mapped_column(String(8), default="ja", nullable=False)
    paper_type: Mapped[str] = mapped_column(String(100), default="research-paper", nullable=False)
    research_field: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    template_id: Mapped[str] = mapped_column(String(100), default="generic-ja", nullable=False)
    page_target: Mapped[int | None] = mapped_column(Integer)
    audience: Mapped[str] = mapped_column(Text, default="", nullable=False)
    venue_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=GenerationStatus.IDLE.value, nullable=False, index=True
    )
    wizard_step: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    typst_source: Mapped[str] = mapped_column(Text, default="", nullable=False)
    pdf_relative_path: Mapped[str | None] = mapped_column(String(1000))

    authors: Mapped[list[Author]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Author.position",
    )
    paper_spec: Mapped[PaperSpec | None] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        uselist=False,
        single_parent=True,
    )
    sections: Mapped[list[Section]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Section.position",
    )
    assets: Mapped[list[ProjectAsset]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    references: Mapped[list[Reference]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Reference.citation_key",
    )
    generation_runs: Mapped[list[GenerationRun]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    instructions: Mapped[list[GenerationInstruction]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    advice: Mapped[list[PaperAdvice]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    compile_results: Mapped[list[CompileResult]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Author(Base, IdMixin, TimestampMixin):
    __tablename__ = "authors"
    __table_args__ = (
        UniqueConstraint("project_id", "position", name="uq_authors_project_position"),
        CheckConstraint("position >= 0", name="ck_authors_position"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    affiliation: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    email: Mapped[str] = mapped_column(String(320), default="", nullable=False)
    orcid: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    corresponding: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    project: Mapped[Project] = relationship(back_populates="authors")


class PaperSpec(Base, IdMixin, TimestampMixin):
    """Persisted normalized research input; relational children stay on Project."""

    __tablename__ = "paper_specs"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    notes: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    achievement: Mapped[str] = mapped_column(Text, default="", nullable=False)
    key_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    background: Mapped[str] = mapped_column(Text, default="", nullable=False)
    problem: Mapped[str] = mapped_column(Text, default="", nullable=False)
    objective: Mapped[str] = mapped_column(Text, default="", nullable=False)
    novelty: Mapped[str] = mapped_column(Text, default="", nullable=False)
    method: Mapped[str] = mapped_column(Text, default="", nullable=False)
    system_design: Mapped[str] = mapped_column(Text, default="", nullable=False)
    experimental_conditions: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metrics: Mapped[str] = mapped_column(Text, default="", nullable=False)
    results: Mapped[str] = mapped_column(Text, default="", nullable=False)
    discussion: Mapped[str] = mapped_column(Text, default="", nullable=False)
    limitations: Mapped[str] = mapped_column(Text, default="", nullable=False)
    conclusion: Mapped[str] = mapped_column(Text, default="", nullable=False)
    future_work: Mapped[str] = mapped_column(Text, default="", nullable=False)
    keywords: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    overall_instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    section_instructions: Mapped[dict[str, str]] = mapped_column(
        MutableDict.as_mutable(JSON), default=dict, nullable=False
    )
    selected_presets: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    japanese_punctuation: Mapped[str] = mapped_column(String(4), default="，．", nullable=False)
    english_variant: Mapped[str] = mapped_column(String(16), default="american", nullable=False)

    project: Mapped[Project] = relationship(back_populates="paper_spec")


class Section(Base, IdMixin, TimestampMixin):
    __tablename__ = "sections"
    __table_args__ = (
        UniqueConstraint("project_id", "slug", name="uq_sections_project_slug"),
        UniqueConstraint("project_id", "position", name="uq_sections_project_position"),
        CheckConstraint("position >= 0", name="ck_sections_position"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    slug: Mapped[str] = mapped_column(String(160), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    generated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    project: Mapped[Project] = relationship(back_populates="sections")
    versions: Mapped[list[SectionVersion]] = relationship(
        back_populates="section",
        cascade="all, delete-orphan",
        order_by="SectionVersion.created_at.desc()",
    )
    instructions: Mapped[list[GenerationInstruction]] = relationship(back_populates="section")


class SectionVersion(Base, IdMixin, TimestampMixin):
    __tablename__ = "section_versions"
    __table_args__ = (Index("ix_section_versions_section_created", "section_id", "created_at"),)

    section_id: Mapped[str] = mapped_column(
        ForeignKey("sections.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    operation: Mapped[str] = mapped_column(String(100), nullable=False)
    provider: Mapped[str | None] = mapped_column(String(100))
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    section: Mapped[Section] = relationship(back_populates="versions")


class Template(Base, TimestampMixin):
    """Optional index of file-backed template manifests."""

    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    supported_languages: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    document_types: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    sections: Mapped[list[dict[str, Any]]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    required_inputs: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    optional_inputs: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    recommended_figures: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    recommended_tables: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    recommended_data: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    page_settings: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSON), default=dict, nullable=False
    )
    columns: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    font_settings: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSON), default=dict, nullable=False
    )
    version: Mapped[str] = mapped_column(String(50), default="1.0.0", nullable=False)


class ProjectAsset(Base, IdMixin, TimestampMixin):
    __tablename__ = "project_assets"
    __table_args__ = (
        UniqueConstraint("project_id", "internal_name", name="uq_assets_project_internal_name"),
        UniqueConstraint("project_id", "relative_path", name="uq_assets_project_relative_path"),
        CheckConstraint("size_bytes >= 0", name="ck_assets_size"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(32), default=AssetKind.OTHER.value, nullable=False)
    display_name: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    purpose: Mapped[str] = mapped_column(Text, default="", nullable=False)
    target_section: Mapped[str | None] = mapped_column(String(160))
    source: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_original: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    internal_name: Mapped[str] = mapped_column(String(160), nullable=False)
    relative_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    extension: Mapped[str] = mapped_column(String(16), nullable=False)
    media_type: Mapped[str | None] = mapped_column(String(200))
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    project: Mapped[Project] = relationship(back_populates="assets")


class Reference(Base, IdMixin, TimestampMixin):
    __tablename__ = "references"
    __table_args__ = (
        UniqueConstraint("project_id", "citation_key", name="uq_references_project_key"),
        CheckConstraint("year IS NULL OR year BETWEEN 1000 AND 9999", name="ck_references_year"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    citation_key: Mapped[str] = mapped_column(String(200, collation="NOCASE"), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(50), default="article", nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    authors: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    year: Mapped[int | None] = mapped_column(Integer)
    venue: Mapped[str] = mapped_column(Text, default="", nullable=False)
    volume: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    issue: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    pages: Mapped[str] = mapped_column(String(100), default="", nullable=False)
    doi: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    url: Mapped[str] = mapped_column(Text, default="", nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)

    project: Mapped[Project] = relationship(back_populates="references")


class GenerationRun(Base, IdMixin, TimestampMixin):
    __tablename__ = "generation_runs"
    __table_args__ = (
        CheckConstraint("progress BETWEEN 0 AND 100", name="ck_generation_runs_progress"),
        Index("ix_generation_runs_project_created", "project_id", "created_at"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    operation: Mapped[str] = mapped_column(String(100), default="generate", nullable=False)
    provider: Mapped[str] = mapped_column(String(100), default="rule-based", nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default=GenerationStatus.IDLE.value, nullable=False, index=True
    )
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    instruction: Mapped[str] = mapped_column(Text, default="", nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    result_data: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSON), default=dict, nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    project: Mapped[Project] = relationship(back_populates="generation_runs")
    compile_results: Mapped[list[CompileResult]] = relationship(back_populates="generation_run")

    @property
    def state(self) -> str:
        return self.status


class GenerationInstruction(Base, IdMixin, TimestampMixin):
    __tablename__ = "generation_instructions"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_id: Mapped[str | None] = mapped_column(
        ForeignKey("sections.id", ondelete="SET NULL"), index=True
    )
    scope: Mapped[str] = mapped_column(String(32), default="project", nullable=False)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    presets: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    project: Mapped[Project] = relationship(back_populates="instructions")
    section: Mapped[Section | None] = relationship(back_populates="instructions")


class PaperAdvice(Base, IdMixin, TimestampMixin):
    __tablename__ = "paper_advice"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category: Mapped[str] = mapped_column(
        String(64), default=AdviceCategory.INFORMATION.value, nullable=False, index=True
    )
    severity: Mapped[str] = mapped_column(
        String(32), default=AdviceSeverity.RECOMMENDED.value, nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    target_section: Mapped[str | None] = mapped_column(String(160))
    suggested_action: Mapped[str] = mapped_column(Text, default="", nullable=False)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)

    project: Mapped[Project] = relationship(back_populates="advice")


class CompileResult(Base, IdMixin, TimestampMixin):
    __tablename__ = "compile_results"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    generation_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("generation_runs.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    command: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    exit_code: Mapped[int | None] = mapped_column(Integer)
    stdout: Mapped[str] = mapped_column(Text, default="", nullable=False)
    stderr: Mapped[str] = mapped_column(Text, default="", nullable=False)
    errors: Mapped[list[str]] = mapped_column(
        MutableList.as_mutable(JSON), default=list, nullable=False
    )
    output_path: Mapped[str | None] = mapped_column(String(1000))
    duration_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    project: Mapped[Project] = relationship(back_populates="compile_results")
    generation_run: Mapped[GenerationRun | None] = relationship(back_populates="compile_results")


class ApplicationSetting(Base, TimestampMixin):
    """Non-secret user setting. Credentials are accepted from environment only."""

    __tablename__ = "application_settings"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSON), default=dict, nullable=False
    )

    @validates("key")
    def reject_secret_keys(self, _attribute: str, key: str) -> str:
        normalized = key.casefold().replace("-", "_")
        secret_fragments = ("api_key", "password", "secret", "token", "credential")
        if any(fragment in normalized for fragment in secret_fragments):
            raise ValueError("secret values must be supplied through environment variables")
        return key

    @validates("value")
    def reject_nested_secret_values(
        self,
        _attribute: str,
        value: dict[str, Any],
    ) -> dict[str, Any]:
        """Refuse credentials hidden inside an otherwise harmless settings row."""

        def contains_secret_key(item: Any) -> bool:
            if isinstance(item, dict):
                for raw_key, nested in item.items():
                    normalized = str(raw_key).casefold().replace("-", "_").replace(" ", "_")
                    secret_key = (
                        "api_key" in normalized
                        or "apikey" in normalized
                        or "password" in normalized
                        or "secret" in normalized
                        or "credential" in normalized
                        or normalized == "token"
                        or normalized.endswith("_token")
                        or normalized.endswith("token")
                    )
                    if secret_key or contains_secret_key(nested):
                        return True
            elif isinstance(item, (list, tuple)):
                return any(contains_secret_key(nested) for nested in item)
            return False

        if contains_secret_key(value):
            raise ValueError("secret values must be supplied through environment variables")
        return value


__all__ = [
    "ApplicationSetting",
    "Author",
    "CompileResult",
    "GenerationInstruction",
    "GenerationRun",
    "PaperAdvice",
    "PaperSpec",
    "Project",
    "ProjectAsset",
    "Reference",
    "Section",
    "SectionVersion",
    "Template",
]
