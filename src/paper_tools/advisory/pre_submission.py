"""Conservative checks that must be completed before submission."""

from __future__ import annotations

import re

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class UnresolvedPlaceholderRule:
    """Report explicit placeholders without attempting to fill them."""

    id = "pre_submission.unresolved-placeholder"
    _placeholder = re.compile(
        r"(?:\\)?\[\s*(?:TODO|DATA\s+NEEDED|FIGURE\s+NEEDED|"
        r"CITATION\s+NEEDED|VERIFY|要追加|要確認)\s*:",
        re.IGNORECASE,
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        manuscript = f"{context.spec.combined_research_text()}\n{context.generated_text}"
        count = len(self._placeholder.findall(manuscript))
        if count == 0:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.PRE_SUBMISSION,
                severity=AdviceSeverity.REQUIRED,
                title="未解決のプレースホルダーを確認してください",
                description=(
                    f"原稿内に未解決のプレースホルダーを{count}件検出しました．"
                    "投稿前に，根拠を確認できた内容だけで解決してください．"
                ),
                reason="TODO，DATA NEEDED，FIGURE NEEDED，CITATION NEEDED，またはVERIFYが残っています．",
                target_section=None,
                suggested_action=(
                    "各マーカーを検索し，確認済みの本文・図表・引用へ置き換えるか，"
                    "未解決である理由を確認してください．"
                ),
            )
        ]
