"""Reference persistence queries."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from paper_tools.exceptions import NotFoundError
from paper_tools.models import Reference
from paper_tools.repositories.base import Repository


class ReferenceRepository(Repository[Reference]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, Reference)

    def get_for_project(self, project_id: str, reference_id: str) -> Reference:
        reference = self.session.scalar(
            select(Reference).where(
                Reference.project_id == project_id,
                Reference.id == reference_id,
            )
        )
        if reference is None:
            raise NotFoundError("参考文献が見つかりません．")
        return reference

    def by_key(self, project_id: str, citation_key: str) -> Reference | None:
        return self.session.scalar(
            select(Reference).where(
                Reference.project_id == project_id,
                func.lower(Reference.citation_key) == citation_key.casefold(),
            )
        )

    def for_project(self, project_id: str) -> Sequence[Reference]:
        return self.session.scalars(
            select(Reference)
            .where(Reference.project_id == project_id)
            .order_by(Reference.citation_key)
        ).all()


__all__ = ["ReferenceRepository"]
