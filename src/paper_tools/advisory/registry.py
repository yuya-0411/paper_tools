"""Rule registration and deterministic evaluation order."""

from __future__ import annotations

from collections.abc import Iterable

from paper_tools.advisory.base import AdviceContext, AdvisoryRule
from paper_tools.advisory.claims import LimitationsRule
from paper_tools.advisory.completeness import NoveltyRule, ObjectiveRule
from paper_tools.advisory.data import (
    ExperimentalConditionsRule,
    QuantitativeEvidenceRule,
    StatisticalInformationRule,
    TrialCountRule,
)
from paper_tools.advisory.experiments import BaselineRule, MetricRule
from paper_tools.advisory.figures import (
    ComparisonTableRule,
    ControlBlockDiagramRule,
    ExperimentEnvironmentFigureRule,
    ResultGraphRule,
    SystemDiagramRule,
)
from paper_tools.advisory.pre_submission import UnresolvedPlaceholderRule
from paper_tools.advisory.references import RelatedWorkReferencesRule
from paper_tools.advisory.reproducibility import AlgorithmParametersRule
from paper_tools.advisory.robotics import RoboticsCompletenessRule
from paper_tools.schemas import PaperAdvice


class AdvisoryRegistry:
    def __init__(self, rules: Iterable[AdvisoryRule] = ()) -> None:
        self._rules: list[AdvisoryRule] = []
        for rule in rules:
            self.register(rule)

    @property
    def rules(self) -> tuple[AdvisoryRule, ...]:
        return tuple(self._rules)

    def register(self, rule: AdvisoryRule) -> None:
        if any(existing.id == rule.id for existing in self._rules):
            raise ValueError(f"duplicate advisory rule id: {rule.id}")
        self._rules.append(rule)

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        results: list[PaperAdvice] = []
        seen: set[str] = set()
        for rule in self._rules:
            for advice in rule.evaluate(context):
                if advice.id not in seen:
                    results.append(advice)
                    seen.add(advice.id)
        return results


def default_advisory_registry() -> AdvisoryRegistry:
    return AdvisoryRegistry(
        [
            ObjectiveRule(),
            NoveltyRule(),
            ExperimentalConditionsRule(),
            QuantitativeEvidenceRule(),
            BaselineRule(),
            TrialCountRule(),
            StatisticalInformationRule(),
            MetricRule(),
            SystemDiagramRule(),
            ControlBlockDiagramRule(),
            ExperimentEnvironmentFigureRule(),
            ResultGraphRule(),
            ComparisonTableRule(),
            RelatedWorkReferencesRule(),
            LimitationsRule(),
            AlgorithmParametersRule(),
            RoboticsCompletenessRule(),
            UnresolvedPlaceholderRule(),
        ]
    )
