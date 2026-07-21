"""Project aggregate persistence queries."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from paper_tools.exceptions import NotFoundError
from paper_tools.models import Author, PaperSpec, Project, Section
from paper_tools.repositories.base import Repository


class ProjectRepository(Repository[Project]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, Project)

    def get_required(self, project_id: str) -> Project:
        project = self.get(project_id)
        if project is None:
            raise NotFoundError("プロジェクトが見つかりません．")
        return project

    def get_aggregate(self, project_id: str) -> Project:
        statement = (
            select(Project)
            .where(Project.id == project_id)
            .options(
                selectinload(Project.authors),
                selectinload(Project.paper_spec),
                selectinload(Project.sections).selectinload(Section.versions),
                selectinload(Project.assets),
                selectinload(Project.references),
                selectinload(Project.generation_runs),
                selectinload(Project.instructions),
                selectinload(Project.advice),
                selectinload(Project.compile_results),
            )
        )
        project = self.session.scalar(statement)
        if project is None:
            raise NotFoundError("プロジェクトが見つかりません．")
        return project

    def list_recent(self, *, limit: int | None = None) -> Sequence[Project]:
        statement = select(Project).order_by(Project.updated_at.desc(), Project.id)
        if limit is not None:
            statement = statement.limit(limit)
        return self.session.scalars(statement).all()

    def replace_authors(self, project: Project, authors: list[Author]) -> None:
        project.authors.clear()
        self.session.flush()
        project.authors.extend(authors)
        self.session.flush()

    def set_paper_spec(self, project: Project, paper_spec: PaperSpec) -> PaperSpec:
        project.paper_spec = paper_spec
        self.session.flush()
        return paper_spec


__all__ = ["ProjectRepository"]
