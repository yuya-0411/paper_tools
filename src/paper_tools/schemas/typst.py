"""Typst rendering and compilation results."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from paper_tools.schemas.generation import GeneratedSection


class TypstDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    template_id: str
    sections: list[GeneratedSection]
    files: dict[str, str] = Field(default_factory=dict)


class CompileStatus(StrEnum):
    SUCCESS = "success"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"
    TIMEOUT = "timeout"
    BUSY = "busy"


class CompileResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: CompileStatus
    success: bool
    command: list[str] = Field(default_factory=list)
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    errors: list[str] = Field(default_factory=list)
    output_path: str | None = None
    duration_ms: int = Field(default=0, ge=0)

    @classmethod
    def unavailable(cls, message: str) -> CompileResult:
        return cls(
            status=CompileStatus.UNAVAILABLE,
            success=False,
            errors=[message],
        )
