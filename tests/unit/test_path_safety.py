from __future__ import annotations

import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.exceptions import ValidationError
from paper_tools.schemas import TypstDocument
from paper_tools.services.projects import ProjectService
from paper_tools.services.typst_renderer import TypstRenderingService
from paper_tools.services.workflow import PaperWorkflowService
from paper_tools.utils.path_safety import resolve_within, safe_project_root


def _directory_symlink(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
    except (NotImplementedError, OSError) as exc:
        if os.name == "nt":
            junction = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True,
                check=False,
                text=True,
            )
            if junction.returncode == 0:
                return
        pytest.skip(f"この環境ではディレクトリのリンクを作成できません: {exc}")


def test_resolve_within_rejects_symlink_to_directory_inside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    target = root / "actual"
    target.mkdir(parents=True)
    link = root / "redirect"
    _directory_symlink(link, target)

    with pytest.raises(ValidationError, match="再解析ポイント"):
        resolve_within(root, "redirect/paper.typ")


def test_resolve_within_rejects_symlink_to_directory_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    link = root / "redirect"
    _directory_symlink(link, outside)

    with pytest.raises(ValidationError):
        resolve_within(root, "redirect/paper.typ")


def test_resolve_within_rejects_dangling_symlink(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    link = root / "redirect"
    _directory_symlink(link, root / "missing")

    with pytest.raises(ValidationError, match="再解析ポイント"):
        resolve_within(root, "redirect/paper.typ")


def test_resolve_within_rejects_symlink_used_as_root(tmp_path: Path) -> None:
    actual_root = tmp_path / "actual-root"
    actual_root.mkdir()
    linked_root = tmp_path / "linked-root"
    _directory_symlink(linked_root, actual_root)

    with pytest.raises(ValidationError, match="再解析ポイント"):
        resolve_within(linked_root, "paper.typ")


def test_safe_project_root_rejects_symlinked_project_directory(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    actual = projects / "actual"
    actual.mkdir(parents=True)
    project_link = projects / "project-1"
    _directory_symlink(project_link, actual)

    with pytest.raises(ValidationError, match="再解析ポイント"):
        safe_project_root(projects, "project-1", create=True)


@pytest.mark.skipif(os.name != "nt", reason="ディレクトリジャンクションはWindows固有です")
def test_resolve_within_rejects_windows_directory_junction(tmp_path: Path) -> None:
    root = tmp_path / "root"
    target = root / "actual"
    target.mkdir(parents=True)
    junction = root / "junction"
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"この環境ではディレクトリジャンクションを作成できません: {result.stderr}")
    try:
        with pytest.raises(ValidationError, match="再解析ポイント"):
            resolve_within(root, "junction/paper.typ")
    finally:
        junction.rmdir()


@pytest.fixture
def workflow_context(tmp_path: Path) -> Iterator[tuple[Session, AppSettings]]:
    settings = AppSettings(
        data_dir=tmp_path / "state",
        database_url="sqlite+pysqlite:///:memory:",
        _env_file=None,
    )
    database = Database(settings)
    database.initialize()
    with database.session() as session:
        yield session, settings
    database.dispose()


def test_workflow_project_directory_uses_shared_redirect_check(
    workflow_context: tuple[Session, AppSettings],
    tmp_path: Path,
) -> None:
    session, settings = workflow_context
    project = ProjectService(session).create_project(name="Path safety")
    settings.projects_dir.mkdir(parents=True)
    outside = tmp_path / "outside-project"
    outside.mkdir()
    _directory_symlink(settings.projects_dir / project.id, outside)

    with pytest.raises(ValidationError, match="再解析ポイント"):
        PaperWorkflowService(session, settings).project_directory(project.id)


def test_renderer_rejects_symlinked_document_parent(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    project_root.mkdir()
    outside = tmp_path / "outside-sections"
    outside.mkdir()
    _directory_symlink(project_root / "sections", outside)
    document = TypstDocument(
        source="safe",
        template_id="generic-ja",
        sections=[],
        files={"sections/introduction.typ": "= Introduction"},
    )

    with pytest.raises(ValueError, match="unsafe document path"):
        TypstRenderingService().write_document(document, project_root)

    assert not (outside / "introduction.typ").exists()
