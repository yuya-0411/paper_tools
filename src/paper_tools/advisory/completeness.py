"""Rules for core research information and structure."""

from __future__ import annotations

from paper_tools.advisory.base import AdviceContext
from paper_tools.schemas import AdviceCategory, AdviceSeverity, PaperAdvice


class ObjectiveRule:
    id = "information.objective"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        objective = context.spec.objective.strip()
        ambiguous = len(objective) < 8 or objective.lower() in {
            "検討する",
            "評価する",
            "to investigate",
            "to evaluate",
        }
        if objective and not ambiguous:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.INFORMATION,
                severity=AdviceSeverity.REQUIRED,
                title="研究目的を明確にしてください",
                description="研究で何を明らかにするのかを，1～2文で明示してください．",
                reason="目的が空または曖昧なため，研究の評価軸を判断できません．",
                target_section="introduction",
                suggested_action="対象，解決する課題，到達点を具体的に入力してください．",
            )
        ]


class NoveltyRule:
    id = "structure.novelty"

    def evaluate(self, context: AdviceContext) -> list[PaperAdvice]:
        if not (context.spec.method or context.spec.system_design) or context.spec.novelty:
            return []
        return [
            PaperAdvice(
                id=self.id,
                category=AdviceCategory.STRUCTURE,
                severity=AdviceSeverity.REQUIRED,
                title="新規性を明示してください",
                description="従来手法と比較した新規性を明示してください．",
                reason="提案手法は入力されていますが，従来手法との差がありません．",
                target_section="introduction",
                suggested_action="既存手法との差分と，その差が有用な理由を記載してください．",
            )
        ]
