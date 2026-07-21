"""Rules ensuring related-work claims point to user-supplied sources."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class RelatedWorkReferencesRule:
    id = "citation.related-work"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        has_related_work = context.has_any(
            "関連研究", "先行研究", "related work", "previous studies", "prior work"
        )
        if not has_related_work or context.spec.references:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.CITATION,
                severity=AdviceSeverity.REQUIRED,
                title="参考文献を登録してください",
                description="関連研究を裏付ける参考文献を登録してください．",
                reason="関連研究への言及がありますが，参考文献が登録されていません．",
                target_section="related-work",
                suggested_action="実際に確認した文献の書誌情報を登録してください．",
            )
        ]
