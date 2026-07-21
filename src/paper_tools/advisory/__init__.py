"""Rule-based advisory engine."""

from paper_tools.advisory.base import AdviceContext, AdvisoryRule
from paper_tools.advisory.registry import AdvisoryRegistry, default_advisory_registry

__all__ = ["AdviceContext", "AdvisoryRegistry", "AdvisoryRule", "default_advisory_registry"]
