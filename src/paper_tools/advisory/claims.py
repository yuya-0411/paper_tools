"""Rules guarding claims and limitation reporting."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class LimitationsRule:
    id = "limitations.missing"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        strong_claim = context.has_any(
            "高い有効性", "非常に有効", "優れている", "highly effective", "superior", "outperforms"
        )
        if not strong_claim or context.spec.limitations:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.LIMITATIONS,
                severity=AdviceSeverity.RECOMMENDED,
                title="適用限界を記載してください",
                description="適用限界，失敗条件，未検証条件を記載してください．",
                reason="高い有効性を主張していますが，制約や失敗例がありません．",
                target_section="limitations",
                suggested_action="適用範囲，失敗例，未検証の条件を明示してください．",
            )
        ]
