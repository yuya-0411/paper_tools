from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.orm import Session

from paper_tools.config import RUNTIME_SETTING_FIELDS, AppSettings
from paper_tools.exceptions import ValidationError
from paper_tools.models import ApplicationSetting
from paper_tools.providers import OllamaProvider, OllamaProviderConfig
from paper_tools.services.projects import ProjectService
from paper_tools.services.templates import TemplateService
from paper_tools.services.typst_compiler import TypstCompileService
from paper_tools.utils.csrf import validate_csrf
from paper_tools.web.dependencies import csrf_token, get_session, get_settings
from paper_tools.web.templating import templates
from paper_tools.web.viewmodels import project_view, template_view

router = APIRouter()
SessionDependency = Annotated[Session, Depends(get_session)]
SettingsDependency = Annotated[AppSettings, Depends(get_settings)]


def _typst_context(settings: AppSettings) -> dict[str, Any]:
    compiler = TypstCompileService(settings.typst_executable, timeout=5)
    executable = compiler.find_executable()
    version = compiler.version() if executable else None
    return {
        "available": executable is not None,
        "label": version or "利用不可",
        "version": version,
        "executable": executable,
    }


@router.get("/", response_class=HTMLResponse)
def home(
    request: Request, session: SessionDependency, settings: SettingsDependency
) -> HTMLResponse:
    recent = ProjectService(session).list_projects(limit=5)
    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={
            "active_page": "",
            "projects": [project_view(project) for project in recent],
            "typst": _typst_context(settings),
            "provider_label": settings.generation_provider,
        },
    )


@router.get("/templates", response_class=HTMLResponse)
def template_list(
    request: Request,
    language: str = Query(default=""),
    document_type: str = Query(default=""),
) -> HTMLResponse:
    manifests = TemplateService().list_templates()
    document_types = sorted({kind for manifest in manifests for kind in manifest.document_types})
    filtered = [
        manifest
        for manifest in manifests
        if (not language or language in manifest.languages)
        and (not document_type or document_type in manifest.document_types)
    ]
    return templates.TemplateResponse(
        request=request,
        name="templates.html",
        context={
            "active_page": "templates",
            "templates": [template_view(manifest) for manifest in filtered],
            "document_types": document_types,
            "selected_language": language,
            "selected_document_type": document_type,
        },
    )


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request, settings: SettingsDependency) -> HTMLResponse:
    ollama_status = "モデル未設定"
    if settings.ollama_model:
        health = await OllamaProvider(
            OllamaProviderConfig(
                base_url=settings.ollama_url,
                model=settings.ollama_model,
                timeout=min(settings.generation_timeout_seconds, 2.0),
                temperature=settings.generation_temperature,
            )
        ).healthcheck()
        ollama_status = health.message
    return templates.TemplateResponse(
        request=request,
        name="settings.html",
        context={
            "active_page": "settings",
            "settings": {
                "provider": settings.generation_provider,
                "data_dir": str(settings.data_dir),
                "backup_count": settings.backup_count,
                "upload_max_mb": settings.upload_max_bytes / (1024 * 1024),
                "typst_executable": settings.typst_executable,
                "compile_timeout_seconds": settings.compile_timeout_seconds,
                "generation_timeout_seconds": settings.generation_timeout_seconds,
                "generation_temperature": settings.generation_temperature,
                "maximum_output_tokens": settings.maximum_output_tokens,
                "ollama_url": settings.ollama_url,
                "ollama_model": settings.ollama_model,
                "openai_base_url": settings.openai_compatible_base_url,
                "openai_model": settings.openai_compatible_model,
                "openai_key_configured": settings.openai_api_key is not None,
                "japanese_punctuation": settings.japanese_punctuation,
                "english_variant": settings.english_variant,
            },
            "typst": _typst_context(settings),
            "ollama_status": ollama_status,
            "upload_limit": f"{settings.upload_max_bytes / (1024 * 1024):.0f} MB",
            "csrf_token": csrf_token(request),
            "saved": request.query_params.get("saved") == "1",
        },
    )


@router.post("/settings", response_class=RedirectResponse)
async def save_settings(
    request: Request,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    token = form.get("csrf_token")
    validate_csrf(request, token if isinstance(token, str) else "")
    try:
        upload_megabytes = float(str(form.get("upload_max_mb", "20")))
        values: dict[str, Any] = {
            "typst_executable": str(form.get("typst_executable", "typst")).strip(),
            "compile_timeout_seconds": float(str(form.get("compile_timeout_seconds", "60"))),
            "upload_max_bytes": int(upload_megabytes * 1024 * 1024),
            "backup_count": int(str(form.get("backup_count", "10"))),
            "generation_provider": str(form.get("generation_provider", "rule-based")).strip(),
            "generation_timeout_seconds": float(str(form.get("generation_timeout_seconds", "120"))),
            "generation_temperature": float(str(form.get("generation_temperature", "0.2"))),
            "maximum_output_tokens": int(str(form.get("maximum_output_tokens", "4096"))),
            "ollama_url": str(form.get("ollama_url", "")).strip(),
            "ollama_model": str(form.get("ollama_model", "")).strip(),
            "openai_compatible_base_url": str(form.get("openai_base_url", "")).strip(),
            "openai_compatible_model": str(form.get("openai_model", "")).strip(),
            "japanese_punctuation": str(form.get("japanese_punctuation", "，．")),
            "english_variant": str(form.get("english_variant", "american")),
        }
    except (TypeError, ValueError) as exc:
        raise ValidationError("設定値の数値形式が不正です．") from exc
    try:
        candidate = AppSettings(**{**settings.model_dump(), **values})
    except PydanticValidationError as exc:
        raise ValidationError(f"設定値を確認してください: {exc.errors()[0]['msg']}") from exc
    persisted_values = {key: getattr(candidate, key) for key in RUNTIME_SETTING_FIELDS}
    row = session.get(ApplicationSetting, "runtime")
    if row is None:
        row = ApplicationSetting(key="runtime", value=persisted_values)
        session.add(row)
    else:
        row.value = persisted_values
    for key, value in persisted_values.items():
        setattr(settings, key, value)
    request.app.state.jobs.timeout_seconds = settings.generation_timeout_seconds
    session.flush()
    return RedirectResponse("/settings?saved=1", status_code=303)
