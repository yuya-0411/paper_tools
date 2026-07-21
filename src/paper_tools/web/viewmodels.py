"""Presentation-only adapters that keep Jinja templates free of ORM logic."""

from __future__ import annotations

import difflib
from datetime import UTC, datetime
from typing import Any

from paper_tools.models import (
    GenerationRun,
    PaperAdvice,
    Project,
    ProjectAsset,
    Reference,
    SectionVersion,
)
from paper_tools.schemas import TemplateManifest
from paper_tools.services.jobs import JobStatus

_STATUS_LABELS = {
    "idle": "未生成",
    "planning": "構成中",
    "generating": "生成中",
    "rendering": "原稿作成中",
    "compiling": "PDF作成中",
    "completed": "完了",
    "failed": "失敗",
    "cancelled": "取消済み",
}
_ADVICE_SEVERITY = {"required": "必須", "recommended": "推奨", "optional": "任意"}
_ADVICE_CATEGORY = {
    "information": "不足情報",
    "data": "データ",
    "figure": "図",
    "table": "表",
    "experiment": "実験",
    "comparison": "比較",
    "metric": "評価指標",
    "reproducibility": "再現性",
    "statistics": "統計",
    "citation": "参考文献",
    "structure": "論理構成",
    "claim": "主張",
    "limitations": "制約",
    "pre_submission": "投稿前確認",
}


def project_view(project: Project) -> dict[str, Any]:
    unresolved = sum(not item.resolved for item in project.advice)
    return {
        "id": project.id,
        "name": project.name,
        "title": project.title,
        "language": project.language,
        "template_id": project.template_id,
        "status": project.status,
        "status_label": _STATUS_LABELS.get(project.status, project.status),
        "pdf_status": "生成済み" if project.pdf_relative_path else "未生成",
        "updated_at_display": format_datetime(project.updated_at),
        "unresolved_advice_count": unresolved,
    }


def template_view(manifest: TemplateManifest) -> dict[str, Any]:
    languages = {"ja": "日本語", "en": "English"}
    return {
        "id": manifest.id,
        "name": manifest.name,
        "description": manifest.description,
        "language_label": " / ".join(languages.get(item, item) for item in manifest.languages),
        "languages": list(manifest.languages),
        "document_type": " / ".join(manifest.document_types),
        "document_types": list(manifest.document_types),
        "columns": manifest.columns,
        "sections": [
            {"id": item.id, "title": item.title_ja if "ja" in manifest.languages else item.title_en}
            for item in manifest.sections
        ],
    }


def advice_view(item: PaperAdvice) -> dict[str, Any]:
    return {
        "id": item.id,
        "category": item.category,
        "category_label": _ADVICE_CATEGORY.get(item.category, item.category),
        "severity": item.severity,
        "severity_label": _ADVICE_SEVERITY.get(item.severity, item.severity),
        "title": item.title,
        "description": item.description,
        "reason": item.reason,
        "target_section": item.target_section,
        "suggested_action": item.suggested_action,
        "resolved": item.resolved,
    }


def asset_view(item: ProjectAsset) -> dict[str, Any]:
    size = item.size_bytes
    if size >= 1024 * 1024:
        size_display = f"{size / (1024 * 1024):.1f} MB"
    elif size >= 1024:
        size_display = f"{size / 1024:.1f} KB"
    else:
        size_display = f"{size} B"
    return {
        "id": item.id,
        "display_name": item.display_name,
        "kind": item.kind,
        "description": item.description,
        "purpose": item.purpose,
        "target_section": item.target_section,
        "source": item.source,
        "is_original": item.is_original,
        "size_display": size_display,
    }


def reference_view(item: Reference, *, used: bool = False) -> dict[str, Any]:
    return {
        "id": item.id,
        "citation_key": item.citation_key,
        "entry_type": item.entry_type,
        "title": item.title,
        "authors_display": "; ".join(item.authors),
        "year": item.year,
        "venue": item.venue,
        "volume": item.volume,
        "issue": item.issue,
        "pages": item.pages,
        "doi": item.doi,
        "url": item.url,
        "note": item.note,
        "used": used,
    }


def version_view(
    item: SectionVersion,
    *,
    section_title: str,
    current_content: str = "",
) -> dict[str, Any]:
    return {
        "id": item.id,
        "action_label": item.operation,
        "target_label": section_title,
        "provider": item.provider,
        "instruction": item.instruction,
        "created_at_display": format_datetime(item.created_at),
        "diff": _bounded_diff(item.content, current_content),
    }


def generation_run_view(item: GenerationRun, *, current_source: str = "") -> dict[str, Any]:
    source = item.result_data.get("source")
    return {
        "id": item.id,
        "action_label": item.operation,
        "provider": item.provider,
        "status": item.status,
        "message": item.message,
        "instruction": item.instruction,
        "created_at_display": format_datetime(item.created_at),
        "has_source": isinstance(source, str),
        "source_diff": _bounded_diff(source, current_source) if isinstance(source, str) else "",
        "error": item.error_message,
        "warnings": [
            str(warning)
            for warning in item.result_data.get("warnings", [])
            if isinstance(warning, str)
        ],
    }


def _bounded_diff(previous: str, current: str, *, max_lines: int = 200) -> str:
    lines = list(
        difflib.unified_diff(
            previous.splitlines(),
            current.splitlines(),
            fromfile="保存版",
            tofile="現在版",
            lineterm="",
        )
    )
    if len(lines) > max_lines:
        lines = [*lines[:max_lines], "... 差分はここで省略されました ..."]
    return "\n".join(lines)


def job_view(item: JobStatus) -> dict[str, Any]:
    return {
        "id": item.id,
        "state": item.state.value,
        "state_label": _STATUS_LABELS.get(item.state.value, item.state.value),
        "progress": item.progress,
        "message": item.message,
        "error": item.error,
    }


def format_datetime(value: datetime) -> str:
    # SQLite drops timezone offsets. All persisted application timestamps are UTC,
    # so restore that meaning before converting to the user's local timezone.
    normalized = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return normalized.astimezone().strftime("%Y-%m-%d %H:%M")
