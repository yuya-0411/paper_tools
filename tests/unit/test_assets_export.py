from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from pathlib import Path, PurePosixPath

import pytest
import yaml
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.exceptions import ConflictError, ValidationError
from paper_tools.services.assets import AssetService
from paper_tools.services.export import ExportService
from paper_tools.services.projects import ProjectService
from paper_tools.services.references import ReferenceService, parse_bibtex


@pytest.fixture
def persistence(tmp_path: Path) -> Iterator[tuple[Session, AppSettings]]:
    settings = AppSettings(
        data_dir=tmp_path / "state",
        upload_max_bytes=32,
        _env_file=None,
    )
    database = Database(settings)
    database.initialize()
    with database.session() as session:
        yield session, settings
    database.dispose()


def test_upload_uses_opaque_name_and_enforces_extension_and_size(
    persistence: tuple[Session, AppSettings],
) -> None:
    session, settings = persistence
    project = ProjectService(session).create_project(name="Assets")
    service = AssetService(session, settings)

    asset = service.store_upload(
        project.id,
        filename=r"..\..\danger.PNG",
        content=b"\x89PNG\r\n\x1a\n",
        kind="figure",
        description="A local figure",
    )

    assert asset.original_filename == "danger.PNG"
    assert asset.internal_name.endswith(".png")
    assert "danger" not in asset.internal_name
    assert asset.relative_path.startswith("figures/")
    assert service.read_asset(project.id, asset.id) == b"\x89PNG\r\n\x1a\n"
    assert service.asset_path(asset).is_relative_to(settings.projects_dir.resolve())

    with pytest.raises(ValidationError, match="拡張子"):
        service.store_upload(project.id, filename="payload.exe", content=b"x")
    with pytest.raises(ValidationError, match="署名"):
        service.store_upload(project.id, filename="fake.png", content=b"not-a-png")
    with pytest.raises(ValidationError, match="サイズ"):
        service.store_upload(project.id, filename="large.csv", content=b"x" * 33)


def test_upload_detects_out_of_band_file_changes(
    persistence: tuple[Session, AppSettings],
) -> None:
    session, settings = persistence
    project = ProjectService(session).create_project(name="Integrity")
    service = AssetService(session, settings)
    asset = service.store_upload(project.id, filename="data.csv", content=b"a,b\n1,2")
    service.asset_path(asset).write_bytes(b"changed")

    with pytest.raises(ValidationError, match="変更"):
        service.read_asset(project.id, asset.id)


def test_reference_crud_import_export_and_usage(
    persistence: tuple[Session, AppSettings],
) -> None:
    session, _settings = persistence
    project = ProjectService(session).create_project(name="References")
    service = ReferenceService(session)
    first = service.create_reference(
        project.id,
        citation_key="Smith2025",
        title="A Safe Method",
        authors=["Alice Smith", "Bob Doe"],
        year=2025,
        venue="Example Conference",
        doi="10.0000/example",
    )
    with pytest.raises(ConflictError, match="既に"):
        service.create_reference(project.id, citation_key="smith2025", title="Duplicate")

    imported = service.import_bibtex(
        project.id,
        """
        @inproceedings{Jones2024,
          title = {Nested {Robot} Results},
          author = {Carol Jones and Dan Li},
          year = {2024},
          booktitle = {Robotics Demo},
          pages = {1--8}
        }
        @article{Smith2025, title={Duplicate existing}, year={2025}}
        """,
    )
    assert [item.citation_key for item in imported.created] == ["Jones2024"]
    assert imported.duplicate_keys == ("Smith2025",)
    assert not imported.errors

    bibtex = service.export_bibtex(project.id)
    assert {entry["citation_key"] for entry in parse_bibtex(bibtex)} == {
        "Jones2024",
        "Smith2025",
    }
    hayagriva = yaml.safe_load(service.export_hayagriva_yaml(project.id))
    assert hayagriva["Smith2025"]["serial-number"]["doi"] == "10.0000/example"
    usage = service.analyze_usage(project.id, ["Smith2025", "Missing2026"])
    assert usage.unused_keys == ("Jones2024",)
    assert usage.missing_keys == ("Missing2026",)

    service.update_reference(project.id, first.id, {"note": "verified"})
    assert first.note == "verified"
    service.delete_reference(project.id, first.id)
    assert [item.citation_key for item in service.list_references(project.id)] == ["Jones2024"]


def test_zip_export_contains_only_safe_declared_members_and_is_deterministic(
    persistence: tuple[Session, AppSettings], tmp_path: Path
) -> None:
    session, settings = persistence
    projects = ProjectService(session)
    project = projects.create_project(
        name="Export Demo",
        title="Demo",
        paper_spec={"objective": "Evaluate the method"},
        sections=[{"id": "introduction", "title": "Introduction", "order": 0, "content": "Body"}],
    )
    project.typst_source = '#include "sections/introduction.typ"\n'
    asset = AssetService(session, settings).store_upload(
        project.id,
        filename="plot.svg",
        content=b"<svg/>",
        kind="figure",
    )
    ReferenceService(session).create_reference(
        project.id,
        citation_key="Demo2026",
        title="Demo Reference",
        year=2026,
    )
    exporter = ExportService(session, settings)

    first = exporter.build_zip(project.id)
    second = exporter.build_zip(project.id)
    assert first == second

    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        names = archive.namelist()
        assert {
            "project.yml",
            "main.typ",
            "sections/introduction.typ",
            "references.yml",
            asset.relative_path,
        } <= set(names)
        assert all(not PurePosixPath(name).is_absolute() for name in names)
        assert all(".." not in PurePosixPath(name).parts for name in names)
        assert archive.read(asset.relative_path) == b"<svg/>"
        manifest = yaml.safe_load(archive.read("project.yml"))
        assert manifest["paper_spec"]["objective"] == "Evaluate the method"

    destination = exporter.export_project(project.id, tmp_path / "paper.zip")
    assert destination.read_bytes() == first


def test_zip_export_rejects_tampered_asset_path(
    persistence: tuple[Session, AppSettings],
) -> None:
    session, settings = persistence
    project = ProjectService(session).create_project(name="Unsafe")
    asset = AssetService(session, settings).store_upload(
        project.id,
        filename="data.json",
        content=b"{}",
    )
    asset.relative_path = "../outside.json"
    session.flush()

    with pytest.raises(ValidationError, match="親ディレクトリ"):
        ExportService(session, settings).build_zip(project.id)
