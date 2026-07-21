"""Rules for algorithm and learning reproducibility."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class AlgorithmParametersRule:
    id = "reproducibility.parameters"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        has_algorithm = context.has_any(
            "アルゴリズム", "学習", "ニューラル", "algorithm", "training", "learning", "neural"
        )
        has_parameters = context.has_any(
            "パラメータ",
            "学習率",
            "seed",
            "エポック",
            "反復回数",
            "parameter",
            "learning rate",
            "epoch",
            "hardware",
        )
        if not has_algorithm or has_parameters:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.REPRODUCIBILITY,
                severity=AdviceSeverity.REQUIRED,
                title="再現に必要なパラメータを追加してください",
                description="主要パラメータ，学習条件，乱数seed，反復回数，ハードウェアを記載してください．",
                reason="アルゴリズムまたは学習手法がありますが，実行条件を確認できません．",
                target_section="method",
                suggested_action="設定値と実行環境を再現可能な粒度で記載してください．",
            )
        ]
