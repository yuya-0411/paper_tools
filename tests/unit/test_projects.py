from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from paper_tools.database import Database
from paper_tools.exceptions import ConflictError, NotFoundError, ValidationError
from paper_tools.models import Author, Project, SectionVersion
from paper_tools.services.projects import ProjectService


@pytest.fixture
def session() -> Iterator[Session]:
    database = Database(database_url="sqlite+pysqlite:///:memory:")
    database.initialize()
    with database.session() as active_session:
        yield active_session
    database.dispose()


def test_create_project_persists_full_normalized_paper_spec(session: Session) -> None:
    service = ProjectService(session)
    project = service.create_project(
        name="  Robot Paper  ",
        title="安全なロボット制御",
        language="ja",
        template_id="robotics-experiment",
        page_target=8,
        authors=[
            {
                "name": "山田 太郎",
                "affiliation": "Example Lab",
                "corresponding": True,
                "order": 0,
            },
            {"name": "佐藤 花子", "order": 1},
        ],
        paper_spec={
            "summary": "研究概要",
            "notes": "第一のメモ\n第二のメモ",
            "objective": "目的",
            "keywords": ["robot", "control"],
            "section_instructions": {"discussion": "限界も説明する"},
        },
        sections=[
            {"id": "introduction", "title": "はじめに", "order": 0, "content": "初稿"},
            {"id": "method", "title": "手法", "order": 1},
        ],
    )

    loaded = service.get_project(project.id)
    assert loaded.name == "Robot Paper"
    assert [author.name for author in loaded.authors] == ["山田 太郎", "佐藤 花子"]
    assert loaded.paper_spec is not None
    assert loaded.paper_spec.notes == ["第一のメモ", "第二のメモ"]
    assert loaded.paper_spec.section_instructions == {"discussion": "限界も説明する"}
    assert [section.slug for section in loaded.sections] == ["introduction", "method"]

    provider_spec = service.to_paper_spec(project.id)
    assert provider_spec.title == "安全なロボット制御"
    assert provider_spec.objective == "目的"
    assert provider_spec.authors[0].corresponding


def test_update_autosave_and_unknown_fields(session: Session) -> None:
    service = ProjectService(session)
    project = service.create_project(name="Draft")

    first = service.autosave_project(
        project.id,
        {"title": "New title", "objective": "Measure safety", "notes": ["one"]},
    )
    second = service.autosave_project(
        project.id,
        {"title": "New title", "objective": "Measure safety", "notes": ["one"]},
    )

    assert first.saved
    assert set(first.changed_fields) == {"title", "objective", "notes"}
    assert not second.saved
    assert service.get_project(project.id).paper_spec.objective == "Measure safety"  # type: ignore[union-attr]

    with pytest.raises(ValidationError, match="未対応"):
        service.update_project(project.id, {"not_a_column": "value"})


def test_section_autosave_deduplicates_versions_and_restore_works(session: Session) -> None:
    service = ProjectService(session)
    project = service.create_project(name="History")
    section = service.create_section(
        project.id,
        slug="results",
        title="Results",
        position=0,
        content="version one",
    )
    initial_version = service.list_section_versions(project.id, section.slug)[0]

    saved = service.autosave_section(project.id, section.slug, content="version two")
    duplicate = service.autosave_section(project.id, section.slug, content="version two")
    service.save_section(project.id, section.slug, content="version three")

    assert saved.saved
    assert not duplicate.saved
    assert len(service.list_section_versions(project.id, section.slug)) == 3

    restored = service.restore_section_version(project.id, section.slug, initial_version.id)
    assert restored.saved
    assert service.sections.required_by_slug(project.id, section.slug).content == "version one"
    assert len(service.list_section_versions(project.id, section.slug)) == 4


def test_project_validation_conflicts_and_cascade_delete(session: Session) -> None:
    service = ProjectService(session)
    with pytest.raises(ValidationError, match="プロジェクト名"):
        service.create_project(name="  ")
    with pytest.raises(ValidationError, match="言語"):
        service.create_project(name="Bad", language="fr")

    project = service.create_project(name="Delete", authors=[{"name": "A", "order": 0}])
    service.create_section(project.id, slug="intro", title="Intro", position=0)
    with pytest.raises(ConflictError, match="セクションID"):
        service.create_section(project.id, slug="intro", title="Again", position=1)
    with pytest.raises(ValidationError, match="セクションID"):
        service.create_section(project.id, slug="../escape", title="Bad", position=2)

    service.delete_project(project.id)
    assert session.scalar(select(func.count()).select_from(Project)) == 0
    assert session.scalar(select(func.count()).select_from(Author)) == 0
    assert session.scalar(select(func.count()).select_from(SectionVersion)) == 0
    with pytest.raises(NotFoundError):
        service.get_project(project.id)
