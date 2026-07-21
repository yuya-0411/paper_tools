"""Public schemas shared by the web, persistence, and generation layers."""

from paper_tools.schemas.advisory import AdviceCategory, AdviceSeverity, PaperAdvice
from paper_tools.schemas.generation import (
    ContentOrigin,
    ContentSegment,
    GeneratedSection,
    GenerationPurpose,
    GenerationRequest,
    GenerationResponse,
    OutlineSection,
    PaperOutline,
)
from paper_tools.schemas.paper import (
    AssetKind,
    AssetSpec,
    AuthorSpec,
    EnglishVariant,
    JapanesePunctuation,
    PaperLanguage,
    PaperSpec,
    ReferenceSpec,
)
from paper_tools.schemas.templates import TemplateManifest, TemplateSection
from paper_tools.schemas.typst import CompileResult, CompileStatus, TypstDocument

__all__ = [
    "AdviceCategory",
    "AdviceSeverity",
    "AssetKind",
    "AssetSpec",
    "AuthorSpec",
    "CompileResult",
    "CompileStatus",
    "ContentOrigin",
    "ContentSegment",
    "EnglishVariant",
    "GeneratedSection",
    "GenerationPurpose",
    "GenerationRequest",
    "GenerationResponse",
    "JapanesePunctuation",
    "OutlineSection",
    "PaperAdvice",
    "PaperLanguage",
    "PaperOutline",
    "PaperSpec",
    "ReferenceSpec",
    "TemplateManifest",
    "TemplateSection",
    "TypstDocument",
]
