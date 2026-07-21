"""Traversal-safe, deterministic project ZIP export."""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings, get_settings
from paper_tools.exceptions import ValidationError
from paper_tools.models import PaperSpec, Project
from paper_tools.repositories import ProjectRepository
from paper_tools.services.assets import AssetService
from paper_tools.services.references import ReferenceService
from paper_tools.utils.path_safety import (
    atomic_write_bytes,
    read_bytes_bounded,
    resolve_within,
    safe_project_root,
    safe_zip_arcname,
)

_EXPORT_PDF_MAX_BYTES = 250 * 1024 * 1024


class ExportService:
    """Export only database-declared files; never recursively copy project folders."""

    def __init__(self, session: Session, settings: AppSettings | None = None) -> None:
        self.session = session
        self.settings = settings or get_settings()
        self.projects = ProjectRepository(session)
        self.asset_service = AssetService(session, self.settings)
        self.reference_service = ReferenceService(session)

    def build_zip(self, project_id: str) -> bytes:
        project = self.projects.get_aggregate(project_id)
        output = io.BytesIO()
        with zipfile.ZipFile(
            output,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
        ) as archive:
            self._write_text(
                archive,
                "project.yml",
                yaml.safe_dump(
                    self._project_manifest(project),
                    allow_unicode=True,
                    sort_keys=False,
                    default_flow_style=False,
                ),
            )
            self._write_text(archive, "main.typ", project.typst_source)
            for section in sorted(project.sections, key=lambda item: (item.position, item.slug)):
                self._write_text(archive, f"sections/{section.slug}.typ", section.content)
            self._write_text(
                archive,
                "references.yml",
                self.reference_service.export_hayagriva_yaml(project.id),
            )
            for asset in sorted(project.assets, key=lambda item: item.relative_path):
                data = self.asset_service.read_asset(project.id, asset.id)
                self._write_bytes(archive, asset.relative_path, data)
            self._include_pdf(archive, project)
        return output.getvalue()

    def export_project(
        self,
        project_id: str,
        destination: Path | None = None,
    ) -> Path:
        project = self.projects.get_required(project_id)
        if destination is None:
            self.settings.exports_dir.mkdir(parents=True, exist_ok=True)
            slug = re.sub(r"[^A-Za-z0-9._-]+", "-", project.name).strip("-.") or "paper"
            destination = self.settings.exports_dir / f"{slug}-{project.id[:8]}.zip"
        destination = destination.expanduser().resolve(strict=False)
        if destination.suffix.casefold() != ".zip":
            raise ValidationError("エクスポート先には .zip ファイルを指定してください．")
        atomic_write_bytes(destination, self.build_zip(project_id))
        return destination

    def _include_pdf(self, archive: zipfile.ZipFile, project: Project) -> None:
        if not project.pdf_relative_path:
            return
        project_root = safe_project_root(self.settings.projects_dir, project.id)
        pdf_path = resolve_within(
            project_root,
            project.pdf_relative_path,
            must_exist=False,
        )
        if not pdf_path.exists():
            return
        if pdf_path.suffix.casefold() != ".pdf":
            raise ValidationError("登録されたPDFパスの拡張子が不正です．")
        pdf = read_bytes_bounded(pdf_path, maximum_bytes=_EXPORT_PDF_MAX_BYTES)
        self._write_bytes(archive, "output/paper.pdf", pdf)

    @staticmethod
    def _project_manifest(project: Project) -> dict[str, Any]:
        stored = project.paper_spec
        spec = ExportService._paper_spec_manifest(stored) if stored is not None else {}
        return {
            "schema_version": 1,
            "id": project.id,
            "name": project.name,
            "title": project.title,
            "language": project.language,
            "paper_type": project.paper_type,
            "research_field": project.research_field,
            "template_id": project.template_id,
            "page_target": project.page_target,
            "audience": project.audience,
            "venue_note": project.venue_note,
            "status": project.status,
            "wizard_step": project.wizard_step,
            "created_at": project.created_at.isoformat(),
            "updated_at": project.updated_at.isoformat(),
            "authors": [
                {
                    "name": author.name,
                    "affiliation": author.affiliation,
                    "email": author.email,
                    "orcid": author.orcid,
                    "corresponding": author.corresponding,
                    "order": author.position,
                }
                for author in project.authors
            ],
            "paper_spec": spec,
            "assets": [
                {
                    "id": asset.id,
                    "kind": asset.kind,
                    "name": asset.display_name,
                    "description": asset.description,
                    "purpose": asset.purpose,
                    "target_section": asset.target_section,
                    "source": asset.source,
                    "is_original": asset.is_original,
                    "relative_path": asset.relative_path,
                    "original_filename": asset.original_filename,
                    "size_bytes": asset.size_bytes,
                    "sha256": asset.sha256,
                }
                for asset in project.assets
            ],
        }

    @staticmethod
    def _paper_spec_manifest(stored: PaperSpec) -> dict[str, Any]:
        return {
            "summary": stored.summary,
            "notes": list(stored.notes),
            "achievement": stored.achievement,
            "key_message": stored.key_message,
            "background": stored.background,
            "problem": stored.problem,
            "objective": stored.objective,
            "novelty": stored.novelty,
            "method": stored.method,
            "system_design": stored.system_design,
            "experimental_conditions": stored.experimental_conditions,
            "metrics": stored.metrics,
            "results": stored.results,
            "discussion": stored.discussion,
            "limitations": stored.limitations,
            "conclusion": stored.conclusion,
            "future_work": stored.future_work,
            "keywords": list(stored.keywords),
            "overall_instruction": stored.overall_instruction,
            "section_instructions": dict(stored.section_instructions),
            "selected_presets": list(stored.selected_presets),
            "japanese_punctuation": stored.japanese_punctuation,
            "english_variant": stored.english_variant,
        }

    @staticmethod
    def _write_text(archive: zipfile.ZipFile, arcname: str, value: str) -> None:
        ExportService._write_bytes(archive, arcname, value.encode("utf-8"))

    @staticmethod
    def _write_bytes(archive: zipfile.ZipFile, arcname: str, value: bytes) -> None:
        safe_name = safe_zip_arcname(arcname)
        info = zipfile.ZipInfo(safe_name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, value)


__all__ = ["ExportService"]
