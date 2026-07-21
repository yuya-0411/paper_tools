"""Application service for deterministic paper diagnostics."""

from __future__ import annotations

from paper_tools.advisory import AdviceContext, AdvisoryRegistry, default_advisory_registry
from paper_tools.schemas import PaperAdvice, PaperSpec


class PaperAdvisoryService:
    def __init__(self, registry: AdvisoryRegistry | None = None) -> None:
        self.registry = registry or default_advisory_registry()

    def analyze(self, spec: PaperSpec, generated_text: str = "") -> list[PaperAdvice]:
        return self.registry.evaluate(AdviceContext(spec=spec, generated_text=generated_text))
