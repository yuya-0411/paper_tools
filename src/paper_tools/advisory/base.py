"""Shared advisory contracts and conservative text helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from paper_tools.schemas import AssetKind, PaperAdvice, PaperSpec


@dataclass(frozen=True, slots=True)
class AdviceContext:
    spec: PaperSpec
    generated_text: str = ""

    @property
    def text(self) -> str:
        return f"{self.spec.combined_research_text()}\n{self.generated_text}".lower()

    def has_any(self, *terms: str) -> bool:
        return any(term.lower() in self.text for term in terms)

    def has_number(self) -> bool:
        return re.search(r"(?<![a-z])[-+]?\d+(?:[.,]\d+)?", self.text) is not None

    def assets(self, *kinds: AssetKind) -> list[str]:
        selected = [asset for asset in self.spec.assets if not kinds or asset.kind in kinds]
        return [
            f"{asset.name} {asset.description} {asset.purpose} {asset.target_section or ''}".lower()
            for asset in selected
        ]

    def has_asset(self, kinds: tuple[AssetKind, ...], *terms: str) -> bool:
        candidates = self.assets(*kinds)
        if not candidates:
            return False
        if not terms:
            return True
        return any(any(term.lower() in candidate for term in terms) for candidate in candidates)


class AdvisoryRule(Protocol):
    @property
    def id(self) -> str: ...

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]: ...
