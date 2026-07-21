from __future__ import annotations

import pytest

from paper_tools.schemas import AdviceCategory, AssetKind, AssetSpec, PaperSpec, ReferenceSpec
from paper_tools.services.advisory import PaperAdvisoryService


def _ids(spec: PaperSpec) -> set[str]:
    return {advice.id for advice in PaperAdvisoryService().analyze(spec)}


def test_missing_objective_is_required() -> None:
    advice = PaperAdvisoryService().analyze(PaperSpec())
    objective = next(item for item in advice if item.id == "information.objective")

    assert objective.severity.value == "required"
    assert "1～2文" in objective.description


def test_clear_objective_satisfies_objective_rule() -> None:
    assert "information.objective" not in _ids(
        PaperSpec(objective="入力情報から再現可能な論文構成を生成する")
    )


def test_method_without_novelty_is_detected() -> None:
    assert "structure.novelty" in _ids(PaperSpec(method="新しい制御器を実装する"))


def test_results_without_conditions_metrics_and_trials_are_detected() -> None:
    ids = _ids(PaperSpec(results="実験結果を取得した"))

    assert "reproducibility.experimental-conditions" in ids
    assert "experiment.trial-count" in ids
    assert "metric.missing" in ids


@pytest.mark.parametrize(
    "claim", ["性能が改善した", "本手法は有効である", "The method improved performance"]
)
def test_claim_without_number_requires_quantitative_evidence(claim: str) -> None:
    assert "data.quantitative-evidence" in _ids(PaperSpec(results=claim))


def test_numeric_claim_does_not_trigger_quantitative_rule() -> None:
    assert "data.quantitative-evidence" not in _ids(PaperSpec(results="成功率が10％改善した"))


def test_proposed_method_with_results_needs_baseline() -> None:
    assert "comparison.baseline" in _ids(PaperSpec(method="提案制御器", results="誤差を測定した"))


def test_explicit_baseline_satisfies_comparison_rule() -> None:
    assert "comparison.baseline" not in _ids(
        PaperSpec(method="提案制御器", results="従来手法をベースラインとして比較した")
    )


def test_repeated_trials_without_dispersion_are_detected() -> None:
    ids = _ids(PaperSpec(results="10回の試行で平均値を算出した"))

    assert "statistics.dispersion" in ids
    assert "experiment.trial-count" not in ids


def test_system_components_without_diagram_are_detected() -> None:
    assert "figure.system-diagram" in _ids(
        PaperSpec(system_design="センサ，制御モジュール，ソフトウェアを接続した")
    )


def test_registered_system_figure_satisfies_rule() -> None:
    asset = AssetSpec(kind=AssetKind.FIGURE, name="システム構成図")
    ids = _ids(
        PaperSpec(
            system_design="センサ，制御モジュール，ソフトウェアを接続した",
            assets=[asset],
        )
    )

    assert "figure.system-diagram" not in ids


def test_control_text_needs_block_diagram() -> None:
    assert "figure.control-block" in _ids(
        PaperSpec(method="センサ情報を制御器へフィードバックする")
    )


def test_experiment_needs_environment_figure() -> None:
    assert "figure.experiment-environment" in _ids(
        PaperSpec(experimental_conditions="実験室で装置を動作させた")
    )


def test_time_series_needs_graph() -> None:
    assert "figure.result-graph" in _ids(PaperSpec(results="速度の時間変化を測定した"))


def test_prose_comparison_needs_table() -> None:
    assert "table.comparison" in _ids(PaperSpec(results="複数手法を比較した"))


def test_related_work_without_registered_reference_is_detected() -> None:
    assert "citation.related-work" in _ids(PaperSpec(background="関連研究を調査した"))


def test_registered_reference_satisfies_related_work_rule() -> None:
    reference = ReferenceSpec(key="known", title="Verified")
    assert "citation.related-work" not in _ids(
        PaperSpec(background="関連研究を調査した", references=[reference])
    )


def test_strong_claim_needs_limitations() -> None:
    assert "limitations.missing" in _ids(PaperSpec(conclusion="提案法は非常に有効である"))


def test_learning_method_needs_reproducibility_parameters() -> None:
    assert "reproducibility.parameters" in _ids(PaperSpec(method="ニューラルモデルを学習する"))


def test_robotics_template_adds_specific_checks() -> None:
    ids = _ids(
        PaperSpec(
            template_id="robotics-experiment",
            objective="移動ロボットの制御性能を明らかにする",
        )
    )

    assert "template.robotics.自由度" in ids
    assert "template.robotics.appearance" in ids


def test_robotics_template_checks_every_required_diagnostic() -> None:
    ids = _ids(
        PaperSpec(
            template_id="robotics-experiment",
            objective="移動ロボットの制御性能を明らかにする",
        )
    )

    assert {
        "template.robotics.自由度",
        "template.robotics.アクチュエータ",
        "template.robotics.センサ",
        "template.robotics.制御周期",
        "template.robotics.失敗例",
        "template.robotics.appearance",
        "figure.system-diagram",
        "figure.experiment-environment",
        "metric.missing",
        "experiment.trial-count",
        "comparison.baseline",
        "figure.result-graph",
        "limitations.missing",
    } <= ids


def test_robotics_evidence_satisfies_template_specific_checks() -> None:
    assets = [
        AssetSpec(kind=AssetKind.PHOTO, name="ロボット外観写真"),
        AssetSpec(kind=AssetKind.FIGURE, name="システム全体構成図"),
        AssetSpec(kind=AssetKind.PHOTO, name="実験環境の配置写真"),
        AssetSpec(kind=AssetKind.GRAPH, name="軌跡の結果グラフ"),
    ]
    ids = _ids(
        PaperSpec(
            template_id="robotics-experiment",
            objective="移動ロボットの制御性能を明らかにする",
            method="6自由度機構をサーボモータで駆動し，IMUセンサを10 msの制御周期で読む",
            experimental_conditions=(
                "屋内の実験室で20回の試行を行い，従来手法をベースラインとして比較する"
            ),
            metrics="軌跡誤差のRMSEを算出する",
            results="20回の試行で軌跡誤差を測定した",
            limitations="濡れた床面は未検証であり，急勾配では失敗例がある",
            assets=assets,
        )
    )

    assert {
        "template.robotics.自由度",
        "template.robotics.アクチュエータ",
        "template.robotics.センサ",
        "template.robotics.制御周期",
        "template.robotics.失敗例",
        "template.robotics.appearance",
        "figure.system-diagram",
        "figure.experiment-environment",
        "metric.missing",
        "experiment.trial-count",
        "comparison.baseline",
        "figure.result-graph",
        "limitations.missing",
    }.isdisjoint(ids)


@pytest.mark.parametrize(
    "marker",
    [
        "[TODO: 実験条件を記載]",
        "[DATA NEEDED: 試行回数を記載]",
        "[FIGURE NEEDED: 結果図を追加]",
        "[CITATION NEEDED: 文献を登録]",
        "[VERIFY: 原資料と照合]",
        r"\[TODO: Typstでエスケープされた項目]",
    ],
)
def test_unresolved_placeholder_is_a_required_pre_submission_check(marker: str) -> None:
    advice = PaperAdvisoryService().analyze(
        PaperSpec(objective="入力情報の不足を診断する"), generated_text=marker
    )
    placeholder = next(
        item for item in advice if item.id == "pre_submission.unresolved-placeholder"
    )

    assert placeholder.category is AdviceCategory.PRE_SUBMISSION
    assert placeholder.severity.value == "required"


def test_plain_bracketed_manuscript_text_is_not_a_placeholder() -> None:
    assert "pre_submission.unresolved-placeholder" not in {
        item.id
        for item in PaperAdvisoryService().analyze(
            PaperSpec(objective="入力情報の不足を診断する"),
            generated_text="測定範囲は[0, 1]である．",
        )
    }


def test_advice_order_and_content_are_deterministic() -> None:
    spec = PaperSpec(method="学習アルゴリズム", results="性能が改善した")
    service = PaperAdvisoryService()

    assert service.analyze(spec) == service.analyze(spec)
    assert all(item.suggested_action and item.reason for item in service.analyze(spec))
