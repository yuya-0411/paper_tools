"""Section and version history persistence queries."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from paper_tools.exceptions import NotFoundError
from paper_tools.models import Section, SectionVersion
from paper_tools.repositories.base import Repository


class SectionRepository(Repository[Section]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, Section)

    def by_slug(self, project_id: str, slug: str) -> Section | None:
        return self.session.scalar(
            select(Section).where(Section.project_id == project_id, Section.slug == slug)
        )

    def required_by_slug(self, project_id: str, slug: str) -> Section:
        section = self.by_slug(project_id, slug)
        if section is None:
            raise NotFoundError("セクションが見つかりません．")
        return section

    def for_project(self, project_id: str) -> Sequence[Section]:
        return self.session.scalars(
            select(Section)
            .where(Section.project_id == project_id)
            .order_by(Section.position, Section.id)
        ).all()

    def versions(self, section_id: str) -> Sequence[SectionVersion]:
        return self.session.scalars(
            select(SectionVersion)
            .where(SectionVersion.section_id == section_id)
            .order_by(SectionVersion.created_at.desc(), SectionVersion.id.desc())
        ).all()

    def latest_version(self, section_id: str) -> SectionVersion | None:
        return self.session.scalar(
            select(SectionVersion)
            .where(SectionVersion.section_id == section_id)
            .order_by(SectionVersion.created_at.desc(), SectionVersion.id.desc())
            .limit(1)
        )


__all__ = ["SectionRepository"]
