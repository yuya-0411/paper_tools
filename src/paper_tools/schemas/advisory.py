"""Schemas for actionable, rule-based paper advice."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class AdviceSeverity(StrEnum):
    REQUIRED = "required"
    RECOMMENDED = "recommended"
    OPTIONAL = "optional"


class AdviceCategory(StrEnum):
    INFORMATION = "information"
    DATA = "data"
    FIGURE = "figure"
    TABLE = "table"
    EXPERIMENT = "experiment"
    COMPARISON = "comparison"
    METRIC = "metric"
    REPRODUCIBILITY = "reproducibility"
    STATISTICS = "statistics"
    CITATION = "citation"
    STRUCTURE = "structure"
    CLAIM = "claim"
    LIMITATIONS = "limitations"
    PRE_SUBMISSION = "pre_submission"


class PaperAdvice(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    category: AdviceCategory
    severity: AdviceSeverity
    title: str
    description: str
    reason: str
    target_section: str | None = None
    suggested_action: str
    resolved: bool = False
