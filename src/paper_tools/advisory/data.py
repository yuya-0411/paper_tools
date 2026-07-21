"""Rules for quantitative evidence and statistical reporting."""

from __future__ import annotations

import re

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class ExperimentalConditionsRule:
    id = "reproducibility.experimental-conditions"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not context.spec.results or context.spec.experimental_conditions:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.REPRODUCIBILITY,
                severity=AdviceSeverity.REQUIRED,
                title="実験条件が不足しています",
                description="再現性のため，実験環境，使用機器，設定値，試行回数を記載してください．",
                reason="結果は入力されていますが，結果を得た条件がありません．",
                target_section="experiments",
                suggested_action="環境，機器，設定値，ソフトウェア，試行回数を追加してください．",
            )
        ]


class QuantitativeEvidenceRule:
    id = "data.quantitative-evidence"
    _claims = (
        "改善した",
        "向上した",
        "高性能",
        "有効である",
        "優れて",
        "improved",
        "effective",
        "outperform",
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        claim_text = (
            f"{context.spec.results} {context.spec.discussion} {context.spec.conclusion}".lower()
        )
        if not any(term in claim_text for term in self._claims):
            return []
        if re.search(r"[-+]?\d+(?:[.,]\d+)?\s*(?:%|％|ms|s|hz|db|m|cm|mm)?", claim_text):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.DATA,
                severity=AdviceSeverity.REQUIRED,
                title="定量的な裏付けが必要です",
                description="性能向上を裏付ける定量値，評価指標，比較条件を追加してください．",
                reason="性能を示す表現がありますが，対応する数値が見つかりません．",
                target_section="results",
                suggested_action="測定値，単位，評価指標，ベースラインとの差を記載してください．",
            )
        ]


class TrialCountRule:
    id = "experiment.trial-count"
    _trial_pattern = re.compile(
        r"(?:試行|実験)\s*\d+\s*回|\d+\s*回(?:の)?試行|"
        r"\d+\s*(?:trials?|runs?)|n\s*=\s*\d+",
        re.IGNORECASE,
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not context.spec.results:
            return []
        text = f"{context.spec.experimental_conditions} {context.spec.results}"
        if self._trial_pattern.search(text):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.EXPERIMENT,
                severity=AdviceSeverity.REQUIRED,
                title="試行回数を記載してください",
                description="試行回数，平均値，ばらつき，成功率を記載してください．",
                reason="実験結果はありますが，試行回数を確認できません．",
                target_section="experiments",
                suggested_action="独立試行数と集計方法を追記してください．",
            )
        ]


class StatisticalInformationRule:
    id = "statistics.dispersion"
    _trials = re.compile(r"複数|反復|繰り返|\d+\s*(?:回|trials?|runs?)", re.IGNORECASE)
    _dispersion = re.compile(
        r"標準偏差|分散|信頼区間|最小値|最大値|standard deviation|variance|confidence interval|\bsd\b",
        re.IGNORECASE,
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        text = f"{context.spec.experimental_conditions} {context.spec.results}"
        if (
            not context.spec.results
            or not self._trials.search(text)
            or self._dispersion.search(text)
        ):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.STATISTICS,
                severity=AdviceSeverity.RECOMMENDED,
                title="ばらつきの情報を追加してください",
                description="標準偏差，信頼区間，最小値・最大値などの提示を検討してください．",
                reason="複数試行が示されていますが，分散情報がありません．",
                target_section="results",
                suggested_action="代表値に加えて，適切なばらつき指標を提示してください．",
            )
        ]
