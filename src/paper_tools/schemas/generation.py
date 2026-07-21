"""Provider-neutral generation contracts."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from paper_tools.schemas.paper import PaperSpec


class ContentOrigin(StrEnum):
    """Provenance retained so supplied facts and generated prose stay distinguishable."""

    USER = "user"
    GENERATED = "generated"
    PLACEHOLDER = "placeholder"


class GenerationPurpose(StrEnum):
    """Distinguish drafting, bounded editing, and full-manuscript translation."""

    DRAFT = "draft"
    TRANSFORM = "transform"
    TRANSLATE = "translate"


class ContentSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    origin: ContentOrigin
    source_field: str | None = None


class OutlineSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    order: int = Field(ge=0)
    purpose: str = ""
    instruction: str = ""


class PaperOutline(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    sections: list[OutlineSection]
    template_id: str
    language: str


class GeneratedSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    content: str
    segments: list[ContentSegment] = Field(default_factory=list)
    instruction_applied: str = ""


class GenerationRequest(BaseModel):
    """Complete request passed to every text generation provider."""

    model_config = ConfigDict(extra="forbid")

    paper_spec: PaperSpec
    purpose: GenerationPurpose = GenerationPurpose.DRAFT
    outline: PaperOutline | None = None
    target_section: str | None = None
    instruction: str = ""
    existing_sections: dict[str, str] = Field(default_factory=dict)


class GenerationResponse(BaseModel):
    """Deterministic shape returned by local and external providers."""

    model_config = ConfigDict(extra="forbid")

    outline: PaperOutline
    sections: list[GeneratedSection]
    missing_information: list[str] = Field(default_factory=list)
    suggested_figures: list[str] = Field(default_factory=list)
    suggested_tables: list[str] = Field(default_factory=list)
    suggested_data: list[str] = Field(default_factory=list)
    provider_name: str
    fallback_used: bool = False
    warnings: list[str] = Field(default_factory=list)
    document_title: str | None = None
    translated_keywords: list[str] = Field(default_factory=list)

    def section(self, section_id: str) -> GeneratedSection | None:
        return next((section for section in self.sections if section.id == section_id), None)
