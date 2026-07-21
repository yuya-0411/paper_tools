"""Normalized, provider-independent paper input."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PaperLanguage(StrEnum):
    """Languages supported by the first release."""

    JAPANESE = "ja"
    ENGLISH = "en"


class EnglishVariant(StrEnum):
    AMERICAN = "american"
    BRITISH = "british"


class JapanesePunctuation(StrEnum):
    COMMA_PERIOD = "，．"
    TOUTEN_KUTEN = "、。"


class AssetKind(StrEnum):
    FIGURE = "figure"
    PHOTO = "photo"
    GRAPH = "graph"
    TABLE = "table"
    DATA = "data"
    LOG = "log"
    OTHER = "other"


class AuthorSpec(BaseModel):
    """Author data supplied by the user; names are never synthesized."""

    model_config = ConfigDict(extra="forbid")

    name: str = ""
    affiliation: str = ""
    email: str = ""
    orcid: str = ""
    corresponding: bool = False
    order: int = Field(default=0, ge=0)

    @field_validator("name", "affiliation", "email", "orcid", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class AssetSpec(BaseModel):
    """Metadata about a local asset; paths are validated by the storage layer."""

    model_config = ConfigDict(extra="forbid")

    kind: AssetKind
    name: str
    description: str = ""
    purpose: str = ""
    target_section: str | None = None
    source: str = ""
    is_original: bool = True
    relative_path: str | None = None

    @field_validator("name", "description", "purpose", "source", mode="before")
    @classmethod
    def strip_required_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ReferenceSpec(BaseModel):
    """A reference explicitly supplied by the user."""

    model_config = ConfigDict(extra="forbid")

    key: str
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = Field(default=None, ge=1000, le=9999)
    venue: str = ""
    doi: str = ""
    url: str = ""

    @field_validator("key", "title", "venue", "doi", "url", mode="before")
    @classmethod
    def strip_reference_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("authors", mode="before")
    @classmethod
    def normalize_authors(cls, value: object) -> object:
        if isinstance(value, tuple):
            return list(value)
        return value


class PaperSpec(BaseModel):
    """Canonical input to planning, generation, rendering, and advisory services."""

    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    title: str = ""
    language: PaperLanguage = PaperLanguage.JAPANESE
    paper_type: str = "research-paper"
    research_field: str = ""
    template_id: str = "generic-ja"
    page_target: int | None = Field(default=None, ge=1, le=1000)
    audience: str = ""
    venue_note: str = ""
    authors: list[AuthorSpec] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)

    summary: str = ""
    notes: list[str] = Field(default_factory=list)
    achievement: str = ""
    key_message: str = ""

    background: str = ""
    problem: str = ""
    objective: str = ""
    novelty: str = ""
    method: str = ""
    system_design: str = ""
    experimental_conditions: str = ""
    metrics: str = ""
    results: str = ""
    discussion: str = ""
    limitations: str = ""
    conclusion: str = ""
    future_work: str = ""

    references: list[ReferenceSpec] = Field(default_factory=list)
    assets: list[AssetSpec] = Field(default_factory=list)
    overall_instruction: str = ""
    section_instructions: dict[str, str] = Field(default_factory=dict)
    japanese_punctuation: JapanesePunctuation = JapanesePunctuation.COMMA_PERIOD
    english_variant: EnglishVariant = EnglishVariant.AMERICAN

    @field_validator(
        "title",
        "paper_type",
        "research_field",
        "template_id",
        "audience",
        "venue_note",
        "summary",
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
        "overall_instruction",
        mode="before",
    )
    @classmethod
    def normalize_text(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return "\n".join(line.rstrip() for line in value.strip().splitlines())

    @field_validator("keywords", "notes", mode="before")
    @classmethod
    def normalize_string_list(cls, value: object) -> object:
        if value is None:
            return []
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        if isinstance(value, tuple):
            return list(value)
        return value

    @field_validator("keywords", "notes")
    @classmethod
    def strip_and_deduplicate(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            item = value.strip()
            if item and item not in result:
                result.append(item)
        return result

    @field_validator("section_instructions")
    @classmethod
    def normalize_instructions(cls, value: dict[str, str]) -> dict[str, str]:
        return {
            key.strip(): instruction.strip()
            for key, instruction in value.items()
            if key.strip() and instruction.strip()
        }

    def combined_research_text(self) -> str:
        """Return user-supplied research prose for conservative rule matching."""

        values = [
            self.summary,
            *self.notes,
            self.achievement,
            self.key_message,
            self.background,
            self.problem,
            self.objective,
            self.novelty,
            self.method,
            self.system_design,
            self.experimental_conditions,
            self.metrics,
            self.results,
            self.discussion,
            self.limitations,
            self.conclusion,
            self.future_work,
        ]
        return "\n".join(value for value in values if value)
