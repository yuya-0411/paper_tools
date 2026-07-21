"""Project asset persistence queries."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from paper_tools.exceptions import NotFoundError
from paper_tools.models import ProjectAsset
from paper_tools.repositories.base import Repository


class AssetRepository(Repository[ProjectAsset]):
    def __init__(self, session: Session) -> None:
        super().__init__(session, ProjectAsset)

    def get_for_project(self, project_id: str, asset_id: str) -> ProjectAsset:
        asset = self.session.scalar(
            select(ProjectAsset).where(
                ProjectAsset.project_id == project_id,
                ProjectAsset.id == asset_id,
            )
        )
        if asset is None:
            raise NotFoundError("ファイルが見つかりません．")
        return asset

    def for_project(self, project_id: str) -> Sequence[ProjectAsset]:
        return self.session.scalars(
            select(ProjectAsset)
            .where(ProjectAsset.project_id == project_id)
            .order_by(ProjectAsset.created_at, ProjectAsset.id)
        ).all()


__all__ = ["AssetRepository"]
