"""Rules recommending figures and tables tied to supplied content."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, AssetKind, PaperAdvice

_VISUALS = (AssetKind.FIGURE, AssetKind.PHOTO, AssetKind.GRAPH)


class SystemDiagramRule:
    id = "figure.system-diagram"
    _components = (
        "装置",
        "モジュール",
        "センサ",
        "ソフトウェア",
        "controller",
        "sensor",
        "module",
        "robot",
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        count = sum(term in context.text for term in self._components)
        if count < 2 or context.has_asset(_VISUALS, "system", "architecture", "構成", "全体"):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.FIGURE,
                severity=AdviceSeverity.RECOMMENDED,
                title="システム構成図を追加してください",
                description="読者が全体構成を把握できるシステム構成図を追加することを推奨します．",
                reason="複数の装置またはモジュールが登場しますが，対応する図がありません．",
                target_section="system-design",
                suggested_action="構成要素，接続関係，情報の流れを1枚の図に整理してください．",
            )
        ]


class ControlBlockDiagramRule:
    id = "figure.control-block"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        terms = (
            "制御器",
            "フィードバック",
            "目標値",
            "センサ情報",
            "controller",
            "feedback",
            "setpoint",
        )
        if not context.has_any(*terms) or context.has_asset(
            _VISUALS, "control", "block", "制御", "ブロック"
        ):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.FIGURE,
                severity=AdviceSeverity.RECOMMENDED,
                title="制御ブロック図を追加してください",
                description="信号の流れを示す制御ブロック図を追加することを推奨します．",
                reason="制御またはフィードバックが説明されていますが，対応する図がありません．",
                target_section="control-method",
                suggested_action="目標値，制御器，対象，センサ，フィードバック経路を図示してください．",
            )
        ]


class ExperimentEnvironmentFigureRule:
    id = "figure.experiment-environment"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        has_experiment = bool(context.spec.experimental_conditions or context.spec.results)
        if not has_experiment or context.has_asset(
            _VISUALS, "environment", "setup", "実験環境", "配置"
        ):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.FIGURE,
                severity=AdviceSeverity.RECOMMENDED,
                title="実験環境の図が不足しています",
                description="実験環境，配置，座標系，主要寸法が分かる図を追加してください．",
                reason="実験が記載されていますが，環境図または写真が登録されていません．",
                target_section="experimental-setup",
                suggested_action="配置と主要寸法が分かる写真または模式図を登録してください．",
            )
        ]


class ResultGraphRule:
    id = "figure.result-graph"
    _series_terms = (
        "時間変化",
        "軌跡",
        "速度",
        "誤差",
        "報酬",
        "損失",
        "time series",
        "trajectory",
        "velocity",
        "error",
        "reward",
        "loss",
    )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not context.has_any(*self._series_terms) or context.has_asset(
            (AssetKind.GRAPH, AssetKind.FIGURE), "result", "graph", "結果", "推移", "軌跡"
        ):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.FIGURE,
                severity=AdviceSeverity.RECOMMENDED,
                title="結果グラフを追加してください",
                description="時系列グラフ，軌跡図，誤差推移などの追加を検討してください．",
                reason="変化量または軌跡を説明していますが，グラフがありません．",
                target_section="results",
                suggested_action="横軸，縦軸，単位，条件，凡例を明記したグラフを追加してください．",
            )
        ]


class ComparisonTableRule:
    id = "table.comparison"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        comparison = context.has_any(
            "複数手法", "複数条件", "比較した", "methods", "conditions", "compared"
        )
        if not comparison or context.has_asset((AssetKind.TABLE,), "comparison", "比較", "result"):
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.TABLE,
                severity=AdviceSeverity.RECOMMENDED,
                title="比較表を追加してください",
                description="条件と結果を整理した比較表を追加することを推奨します．",
                reason="複数の手法または条件を文章で比較していますが，表がありません．",
                target_section="results",
                suggested_action="行に手法，列に条件・指標を配置し，単位を明記してください．",
            )
        ]
