"""Safe local upload storage and ProjectAsset metadata operations."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4
from xml.etree import ElementTree

import yaml
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings, get_settings
from paper_tools.exceptions import ValidationError
from paper_tools.models import AssetKind, ProjectAsset
from paper_tools.repositories import AssetRepository, ProjectRepository
from paper_tools.utils.path_safety import (
    atomic_write_bytes,
    read_bytes_bounded,
    resolve_within,
    safe_project_root,
    sanitize_uploaded_filename,
)

_FIGURE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".svg", ".pdf"}
_ASSET_KINDS = {kind.value for kind in AssetKind}


class AssetService:
    """Store files under an opaque name and never trust client path or MIME data."""

    def __init__(self, session: Session, settings: AppSettings | None = None) -> None:
        self.session = session
        self.settings = settings or get_settings()
        self.projects = ProjectRepository(session)
        self.assets = AssetRepository(session)

    def store_upload(
        self,
        project_id: str,
        *,
        filename: str,
        content: bytes | BinaryIO,
        display_name: str | None = None,
        kind: str = AssetKind.OTHER.value,
        description: str = "",
        purpose: str = "",
        target_section: str | None = None,
        source: str = "",
        is_original: bool = True,
        media_type: str | None = None,
    ) -> ProjectAsset:
        self.projects.get_required(project_id)
        original_name = sanitize_uploaded_filename(filename)
        extension = Path(original_name).suffix.casefold()
        if extension not in self.settings.allowed_upload_extensions:
            allowed = ", ".join(sorted(self.settings.allowed_upload_extensions))
            raise ValidationError(f"許可されていない拡張子です．利用可能: {allowed}")
        if kind not in _ASSET_KINDS:
            raise ValidationError("ファイル種別が不正です．")
        data = self._read_upload(content)
        self._validate_content(extension, data)
        folder = self._storage_folder(kind, extension)
        internal_name = f"{uuid4().hex}{extension}"
        relative_path = f"{folder}/{internal_name}"
        project_root = safe_project_root(self.settings.projects_dir, project_id, create=True)
        destination = resolve_within(project_root, relative_path)
        atomic_write_bytes(destination, data)
        asset = ProjectAsset(
            project_id=project_id,
            kind=kind,
            display_name=(display_name or original_name).strip() or original_name,
            description=description.strip(),
            purpose=purpose.strip(),
            target_section=target_section.strip() if target_section else None,
            source=source.strip(),
            is_original=is_original,
            original_filename=original_name,
            internal_name=internal_name,
            relative_path=relative_path,
            extension=extension,
            media_type=media_type,
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )
        try:
            self.assets.add(asset)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return asset

    def list_assets(self, project_id: str) -> Sequence[ProjectAsset]:
        self.projects.get_required(project_id)
        return self.assets.for_project(project_id)

    def get_asset(self, project_id: str, asset_id: str) -> ProjectAsset:
        return self.assets.get_for_project(project_id, asset_id)

    def update_metadata(
        self,
        project_id: str,
        asset_id: str,
        values: Mapping[str, Any],
    ) -> ProjectAsset:
        asset = self.assets.get_for_project(project_id, asset_id)
        allowed = {
            "display_name",
            "kind",
            "description",
            "purpose",
            "target_section",
            "source",
            "is_original",
        }
        unknown = set(values) - allowed
        if unknown:
            raise ValidationError(f"未対応のファイル情報です: {', '.join(sorted(unknown))}")
        if "kind" in values and values["kind"] not in _ASSET_KINDS:
            raise ValidationError("ファイル種別が不正です．")
        for field, raw_value in values.items():
            value = raw_value.strip() if isinstance(raw_value, str) else raw_value
            if field == "target_section" and value == "":
                value = None
            setattr(asset, field, value)
        if not asset.display_name:
            raise ValidationError("表示名を入力してください．")
        self.session.flush()
        return asset

    def asset_path(self, asset: ProjectAsset, *, must_exist: bool = True) -> Path:
        project_root = safe_project_root(self.settings.projects_dir, asset.project_id)
        return resolve_within(project_root, asset.relative_path, must_exist=must_exist)

    def read_asset(self, project_id: str, asset_id: str) -> bytes:
        asset = self.assets.get_for_project(project_id, asset_id)
        path = self.asset_path(asset)
        data = read_bytes_bounded(path, maximum_bytes=self.settings.upload_max_bytes)
        if len(data) != asset.size_bytes or hashlib.sha256(data).hexdigest() != asset.sha256:
            raise ValidationError("保存ファイルが登録時から変更されています．")
        return data

    def remove_asset(self, project_id: str, asset_id: str) -> None:
        asset = self.assets.get_for_project(project_id, asset_id)
        path = self.asset_path(asset, must_exist=False)
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise ValidationError("削除対象が通常ファイルではありません．")
            path.unlink()
        self.assets.delete(asset)

    def _read_upload(self, content: bytes | BinaryIO) -> bytes:
        maximum = self.settings.upload_max_bytes
        if isinstance(content, bytes):
            data = content
        else:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = content.read(min(1024 * 1024, maximum - total + 1))
                if not chunk:
                    break
                if not isinstance(chunk, bytes):
                    raise ValidationError("アップロード内容をバイナリで読み込めません．")
                chunks.append(chunk)
                total += len(chunk)
                if total > maximum:
                    raise ValidationError("ファイルサイズが上限を超えています．")
            data = b"".join(chunks)
        if len(data) > maximum:
            raise ValidationError("ファイルサイズが上限を超えています．")
        return data

    @staticmethod
    def _storage_folder(kind: str, extension: str) -> str:
        if (
            kind
            in {
                AssetKind.FIGURE.value,
                AssetKind.PHOTO.value,
                AssetKind.GRAPH.value,
            }
            or extension in _FIGURE_EXTENSIONS
        ):
            return "figures"
        return "data"

    @staticmethod
    def _validate_content(extension: str, data: bytes) -> None:
        """Validate signatures or parse text formats without trusting MIME headers."""

        try:
            if extension == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("invalid PNG signature")
            if extension in {".jpg", ".jpeg"} and not (
                data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9")
            ):
                raise ValueError("invalid JPEG signature")
            if extension == ".pdf" and not data.startswith(b"%PDF-"):
                raise ValueError("invalid PDF signature")
            if extension == ".svg":
                text = data.decode("utf-8-sig")
                lowered = text.casefold()
                if any(
                    marker in lowered
                    for marker in ("<!doctype", "<!entity", "<script", "javascript:")
                ):
                    raise ValueError("active SVG content")
                root = ElementTree.fromstring(text)
                if root.tag.rsplit("}", 1)[-1].casefold() != "svg":
                    raise ValueError("root is not SVG")
                if any(
                    attribute.casefold().startswith("on")
                    for element in root.iter()
                    for attribute in element.attrib
                ):
                    raise ValueError("SVG event handler")
            if extension in {".csv", ".json", ".txt", ".yml", ".yaml"}:
                text = data.decode("utf-8-sig")
                if extension == ".csv":
                    list(csv.reader(io.StringIO(text)))
                elif extension == ".json":
                    json.loads(text)
                elif extension in {".yml", ".yaml"}:
                    yaml.safe_load(text)
        except (UnicodeDecodeError, ValueError, ElementTree.ParseError, yaml.YAMLError) as exc:
            raise ValidationError(f"{extension}ファイルの内容または署名を確認できません．") from exc


__all__ = ["AssetService"]
