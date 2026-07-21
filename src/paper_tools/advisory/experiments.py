"""Rules for comparisons and evaluation design."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class BaselineRule:
    id = "comparison.baseline"
    _baseline_terms = (
        "従来手法",
        "既存手法",
        "ベースライン",
        "比較対象",
        "アブレーション",
        "baseline",
        "prior method",
        "existing method",
        "ablation",
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not context.spec.method or not context.spec.results:
            return []
        if context.has_any(*self._baseline_terms):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.COMPARISON,
                severity=AdviceSeverity.RECOMMENDED,
                title="比較対象を検討してください",
                description="従来手法，既存設定，またはアブレーション条件との比較を検討してください．",
                reason="提案手法の結果がありますが，比較対象を確認できません．",
                target_section="experiments",
                suggested_action="妥当なベースラインと，同一条件での比較方法を追加してください．",
            )
        ]


class MetricRule:
    id = "metric.missing"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not context.spec.results or context.spec.metrics:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.METRIC,
                severity=AdviceSeverity.REQUIRED,
                title="評価指標を定義してください",
                description="結果の良否を判断する評価指標と計算方法を追加してください．",
                reason="結果は入力されていますが，評価指標がありません．",
                target_section="evaluation-metrics",
                suggested_action="指標名，単位，算出式，値の解釈を記載してください．",
            )
        ]
