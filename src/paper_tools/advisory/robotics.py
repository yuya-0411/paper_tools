"""Additional diagnostics for the original robotics experiment template."""

from __future__ import annotations

import re

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, AssetKind, PaperAdvice


class RoboticsCompletenessRule:
    id = "template.robotics-completeness"

    _trial_pattern = re.compile(
        r"(?:試行|実験)\s*\d+\s*回|\d+\s*回(?:の)?試行|"
        r"\d+\s*(?:trials?|runs?)|n\s*=\s*\d+",
        re.IGNORECASE,
    )
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

    @staticmethod
    def _advice(
        *,
        advice_id: str,
        label: str,
        category: AdviceCategory,
        severity: AdviceSeverity,
        section: str,
        action: str,
    ) -> PaperAdvice:
        return PaperAdvice(
            id=advice_id,
            category=category,
            severity=severity,
            title=f"{label}を確認できません",
            description=f"ロボティクス実験の理解と再現のため，{label}を記載してください．",
            reason=(
                f"入力内容と登録済みアセットから，robotics-experimentに必要な{label}を"
                "確認できませんでした．"
            ),
            target_section=section,
            suggested_action=action,
        )

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if context.spec.template_id != "robotics-experiment":
            return []
        checks = [
            (
                "自由度",
                ("自由度", "dof", "degree of freedom"),
                AdviceCategory.INFORMATION,
                "system-design",
            ),
            (
                "アクチュエータ",
                (
                    "アクチュエータ",
                    "モータ",
                    "モーター",
                    "サーボ",
                    "actuator",
                    "motor",
                    "servo",
                ),
                AdviceCategory.INFORMATION,
                "system-design",
            ),
            (
                "センサ",
                (
                    "センサ",
                    "sensor",
                    "imu",
                    "lidar",
                    "camera",
                    "カメラ",
                    "encoder",
                    "エンコーダ",
                ),
                AdviceCategory.INFORMATION,
                "system-design",
            ),
            (
                "制御周期",
                (
                    "制御周期",
                    "サンプリング周期",
                    "control period",
                    "sampling period",
                    "sampling rate",
                    "sampling frequency",
                    "hz",
                ),
                AdviceCategory.REPRODUCIBILITY,
                "control-method",
            ),
            (
                "失敗例",
                ("失敗例", "失敗条件", "failure case", "failure condition", "failed trial"),
                AdviceCategory.LIMITATIONS,
                "limitations",
            ),
        ]
        advice: list[PaperAdvice] = []
        for slug, terms, category, section in checks:
            if context.has_any(*terms):
                continue
            advice.append(
                self._advice(
                    advice_id=f"template.robotics.{slug}",
                    label=slug,
                    category=category,
                    severity=AdviceSeverity.RECOMMENDED,
                    section=section,
                    action=f"実機，仕様書，または実験記録で{slug}を確認して追記してください．",
                )
            )

        if not context.has_asset((AssetKind.FIGURE, AssetKind.PHOTO), "robot", "ロボット", "外観"):
            advice.append(
                PaperAdvice(
                    id="template.robotics.appearance",
                    category=AdviceCategory.FIGURE,
                    severity=AdviceSeverity.RECOMMENDED,
                    title="ロボット外観図を追加してください",
                    description="機構と主要構成要素が分かるロボット外観図を追加してください．",
                    reason="robotics-experimentテンプレートの推奨図が登録されていません．",
                    target_section="system-design",
                    suggested_action="自作写真または出典を明示した図を登録してください．",
                )
            )

        if not context.has_asset(
            (AssetKind.FIGURE,), "system", "architecture", "システム", "構成", "全体"
        ):
            advice.append(
                self._advice(
                    advice_id="figure.system-diagram",
                    label="システム構成図",
                    category=AdviceCategory.FIGURE,
                    severity=AdviceSeverity.RECOMMENDED,
                    section="system-design",
                    action="構成要素，接続関係，情報の流れが分かる図を登録してください．",
                )
            )

        environment_text = context.spec.experimental_conditions.lower()
        environment_terms = (
            "実験環境",
            "実験室",
            "屋内",
            "屋外",
            "床面",
            "照明",
            "environment",
            "laboratory",
            "indoor",
            "outdoor",
            "surface",
        )
        has_environment = any(term in environment_text for term in environment_terms)
        has_environment_asset = context.has_asset(
            (AssetKind.FIGURE, AssetKind.PHOTO),
            "environment",
            "setup",
            "実験環境",
            "配置",
        )
        if not has_environment and not has_environment_asset:
            advice.append(
                self._advice(
                    advice_id="figure.experiment-environment",
                    label="実験環境",
                    category=AdviceCategory.FIGURE,
                    severity=AdviceSeverity.RECOMMENDED,
                    section="experimental-setup",
                    action="環境，配置，座標系，主要寸法を実験記録から追記してください．",
                )
            )

        if not context.spec.metrics.strip():
            advice.append(
                self._advice(
                    advice_id="metric.missing",
                    label="評価指標と算出方法",
                    category=AdviceCategory.METRIC,
                    severity=AdviceSeverity.REQUIRED,
                    section="evaluation-metrics",
                    action="指標名，単位，算出式，値の解釈を確認して追記してください．",
                )
            )

        trial_text = f"{context.spec.experimental_conditions} {context.spec.results}"
        if not self._trial_pattern.search(trial_text):
            advice.append(
                self._advice(
                    advice_id="experiment.trial-count",
                    label="試行回数",
                    category=AdviceCategory.EXPERIMENT,
                    severity=AdviceSeverity.REQUIRED,
                    section="experimental-setup",
                    action="独立試行数と集計方法を実験記録から追記してください．",
                )
            )

        if not context.has_any(*self._baseline_terms):
            advice.append(
                self._advice(
                    advice_id="comparison.baseline",
                    label="比較対象",
                    category=AdviceCategory.COMPARISON,
                    severity=AdviceSeverity.RECOMMENDED,
                    section="experimental-setup",
                    action="妥当な比較対象と，同一条件での比較方法を検討してください．",
                )
            )

        if not context.has_asset(
            (AssetKind.GRAPH, AssetKind.FIGURE),
            "result",
            "graph",
            "結果",
            "推移",
            "軌跡",
            "誤差",
        ):
            advice.append(
                self._advice(
                    advice_id="figure.result-graph",
                    label="結果グラフ",
                    category=AdviceCategory.FIGURE,
                    severity=AdviceSeverity.RECOMMENDED,
                    section="results",
                    action="確認済みの測定値を用い，軸，単位，条件，凡例を明記した図を登録してください．",
                )
            )

        if not context.spec.limitations.strip():
            advice.append(
                self._advice(
                    advice_id="limitations.missing",
                    label="制約と適用限界",
                    category=AdviceCategory.LIMITATIONS,
                    severity=AdviceSeverity.RECOMMENDED,
                    section="limitations",
                    action="適用範囲，失敗条件，未検証条件を確認して追記してください．",
                )
            )
        return advice
