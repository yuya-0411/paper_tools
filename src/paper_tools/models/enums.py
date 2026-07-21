"""Persisted domain enumerations."""

from enum import StrEnum


class GenerationStatus(StrEnum):
    IDLE = "idle"
    PLANNING = "planning"
    GENERATING = "generating"
    RENDERING = "rendering"
    COMPILING = "compiling"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


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
    CITATION = "citation"
    STRUCTURE = "structure"
    REPRODUCIBILITY = "reproducibility"
    STATISTICS = "statistics"
    CLAIM = "claim"
    LIMITATIONS = "limitations"
    PRE_SUBMISSION = "pre_submission"


class AssetKind(StrEnum):
    FIGURE = "figure"
    PHOTO = "photo"
    GRAPH = "graph"
    TABLE = "table"
    DATA = "data"
    LOG = "log"
    OTHER = "other"


__all__ = ["AdviceCategory", "AdviceSeverity", "AssetKind", "GenerationStatus"]
