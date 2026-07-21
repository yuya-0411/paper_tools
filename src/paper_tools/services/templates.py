"""Discovery and validation for original, package-owned Typst templates."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml
from jinja2 import FileSystemLoader, StrictUndefined, TemplateError
from jinja2.sandbox import SandboxedEnvironment
from pydantic import ValidationError

from paper_tools.schemas import TemplateManifest

_SAFE_TEMPLATE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class TemplateServiceError(RuntimeError):
    """Base error suitable for presentation by the web layer."""


class TemplateNotFoundError(TemplateServiceError):
    """A requested package template does not exist or has an unsafe ID."""


class TemplateValidationError(TemplateServiceError):
    """A manifest is malformed or inconsistent with its directory."""


class TemplateRenderError(TemplateServiceError):
    """A validated package template could not be rendered."""


class TemplateService:
    """Load manifests and render only templates below a configured safe root."""

    def __init__(self, template_root: Path | None = None) -> None:
        default_root = Path(__file__).resolve().parent.parent / "templates"
        self.template_root = (template_root or default_root).resolve()
        self._cache: dict[str, TemplateManifest] = {}

    def list_templates(self) -> list[TemplateManifest]:
        if not self.template_root.is_dir():
            return []
        manifests = [
            self.get_template(path.name)
            for path in self.template_root.iterdir()
            if path.is_dir() and (path / "manifest.yml").is_file()
        ]
        return sorted(manifests, key=lambda item: item.id)

    def get_template(self, template_id: str) -> TemplateManifest:
        template_dir = self._template_dir(template_id)
        cached = self._cache.get(template_id)
        if cached is not None:
            return cached
        manifest_path = template_dir / "manifest.yml"
        if not manifest_path.is_file():
            raise TemplateNotFoundError(f"テンプレートが見つかりません: {template_id}")
        try:
            raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise TemplateValidationError("manifest.yml must contain a mapping")
            manifest = TemplateManifest.model_validate(raw)
        except (OSError, yaml.YAMLError, ValidationError) as exc:
            raise TemplateValidationError(
                f"テンプレート定義を読み込めません: {template_id}: {exc}"
            ) from exc
        if manifest.id != template_id:
            raise TemplateValidationError(
                f"manifest id '{manifest.id}' does not match directory '{template_id}'"
            )
        self._cache[template_id] = manifest
        return manifest

    def render(self, template_id: str, context: dict[str, Any]) -> str:
        template_dir = self._template_dir(template_id)
        self.get_template(template_id)
        environment = SandboxedEnvironment(
            loader=FileSystemLoader(str(template_dir)),
            undefined=StrictUndefined,
            autoescape=False,
            keep_trailing_newline=True,
        )
        environment.filters.clear()
        try:
            template = environment.get_template("main.typ.j2")
            return template.render(**context)
        except (TemplateError, OSError) as exc:
            raise TemplateRenderError(f"Typstテンプレートの描画に失敗しました: {exc}") from exc

    def clear_cache(self) -> None:
        self._cache.clear()

    def _template_dir(self, template_id: str) -> Path:
        if not _SAFE_TEMPLATE_ID.fullmatch(template_id):
            raise TemplateNotFoundError("不正なテンプレートIDです")
        path = (self.template_root / template_id).resolve()
        if path.parent != self.template_root:
            raise TemplateNotFoundError("テンプレートディレクトリ外は参照できません")
        return path
