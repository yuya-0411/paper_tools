"""Validated on-disk template manifest schema."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TemplateSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title_ja: str
    title_en: str
    purpose_ja: str = ""
    purpose_en: str = ""


class TemplateManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str
    languages: list[str]
    document_types: list[str]
    sections: list[TemplateSection]
    required_inputs: list[str] = Field(default_factory=list)
    optional_inputs: list[str] = Field(default_factory=list)
    recommended_figures: list[str] = Field(default_factory=list)
    recommended_tables: list[str] = Field(default_factory=list)
    recommended_data: list[str] = Field(default_factory=list)
    page: dict[str, object] = Field(default_factory=dict)
    columns: int = Field(default=1, ge=1, le=4)
    fonts: dict[str, str] = Field(default_factory=dict)
    version: str
    intended_use: str = ""
    original: bool = True

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not value or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for char in value):
            raise ValueError("template id must use lowercase ASCII letters, digits, '-' or '_'")
        return value

    @field_validator("languages")
    @classmethod
    def validate_languages(cls, value: list[str]) -> list[str]:
        if not value or any(language not in {"ja", "en"} for language in value):
            raise ValueError("languages must contain only 'ja' and/or 'en'")
        return value

    @field_validator("sections")
    @classmethod
    def validate_unique_sections(cls, value: list[TemplateSection]) -> list[TemplateSection]:
        ids = [section.id for section in value]
        if not ids or len(ids) != len(set(ids)):
            raise ValueError("template sections must be non-empty and have unique ids")
        return value
