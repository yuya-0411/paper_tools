from __future__ import annotations

import html
import json
import os
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any
from urllib.parse import parse_qs, quote, urlsplit

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from sqlalchemy.orm import Session
from starlette.datastructures import FormData, UploadFile

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.exceptions import NotFoundError, ValidationError
from paper_tools.models import Section, SectionVersion
from paper_tools.services.assets import AssetService
from paper_tools.services.export import ExportService
from paper_tools.services.jobs import JobManager, JobState
from paper_tools.services.projects import ProjectService
from paper_tools.services.references import ReferenceService
from paper_tools.services.templates import TemplateService
from paper_tools.services.typst_compiler import CompileCancellation, run_cancellable_compile
from paper_tools.services.workflow import PaperWorkflowService
from paper_tools.utils.csrf import validate_csrf
from paper_tools.utils.path_safety import resolve_within
from paper_tools.web.dependencies import (
    csrf_token,
    get_database,
    get_job_manager,
    get_session,
    get_settings,
)
from paper_tools.web.templating import templates
from paper_tools.web.viewmodels import (
    advice_view,
    asset_view,
    generation_run_view,
    job_view,
    project_view,
    reference_view,
    template_view,
    version_view,
)

router = APIRouter()
SessionDependency = Annotated[Session, Depends(get_session)]
SettingsDependency = Annotated[AppSettings, Depends(get_settings)]
DatabaseDependency = Annotated[Database, Depends(get_database)]
JobsDependency = Annotated[JobManager, Depends(get_job_manager)]
_CITATION_RE = re.compile(r"@([A-Za-z0-9_.:+/-]+)")
_PLACEHOLDER_MARKER_RE = re.compile(
    r"(?:\\)?\[\s*(?:TODO|DATA\s+NEEDED|FIGURE\s+NEEDED|CITATION\s+NEEDED|VERIFY)\s*:",
    re.IGNORECASE,
)
_MAX_TRANSFORM_SELECTION_CHARS = 100_000
_PRESETS = [
    ("concise", "簡潔"),
    ("detailed", "詳細"),
    ("academic", "学術的"),
    ("readable", "読みやすさ優先"),
    ("novelty", "新規性を強調"),
    ("results", "実験結果を重視"),
    ("cautious", "過剰な主張を避ける"),
    ("reproducible", "再現性を重視"),
    ("review", "査読対応を意識"),
    ("short", "短報向け"),
    ("english-editing", "英文校正向け"),
]
_TRANSFORM_INSTRUCTIONS = {
    "improve": "入力済みの事実を保ったまま，文章を明確で読みやすく改善する．",
    "shorten": "意味と事実を保ったまま，冗長な表現を削って短縮する．",
    "expand": "新しい事実や数値を追加せず，既存情報の説明を詳しくする．",
    "academic": "過剰な主張を避け，学術論文に適した表現へ変更する．",
    "translate-en": "固有名詞と数値を保持し，Academic Englishへ翻訳する．",
    "translate-ja": "固有名詞と数値を保持し，日本語の学術文体へ翻訳する．",
    "prose": "箇条書きを，事実を追加せず論理的な文章へ変換する．",
    "bullets": "内容を失わず，主要点を箇条書きへ整理する．",
}


def _generation_timeout_callback(
    database: Database,
    settings: AppSettings,
    project_id: str,
    timeout_seconds: float,
) -> Callable[[], Awaitable[None]]:
    async def persist_timeout() -> None:
        with database.session() as timeout_session:
            PaperWorkflowService(timeout_session, settings).mark_generation_timeout(
                project_id,
                timeout_seconds=timeout_seconds,
            )

    return persist_timeout


@router.get("/projects", response_class=HTMLResponse)
def project_list(request: Request, session: SessionDependency) -> HTMLResponse:
    projects = ProjectService(session).list_projects()
    return templates.TemplateResponse(
        request=request,
        name="projects/list.html",
        context={
            "active_page": "projects",
            "projects": [project_view(project) for project in projects],
            "csrf_token": csrf_token(request),
        },
    )


@router.get("/projects/new", response_class=HTMLResponse)
def new_project(
    request: Request,
    settings: SettingsDependency,
    template: str | None = Query(default=None),
) -> HTMLResponse:
    manifests = TemplateService().list_templates()
    selected = (
        template if template and any(item.id == template for item in manifests) else "generic-ja"
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/new.html",
        context={
            "active_page": "projects",
            "csrf_token": csrf_token(request),
            "templates": [template_view(item) for item in manifests],
            "selected_template_id": selected,
            "presets": [{"id": item[0], "label": item[1]} for item in _PRESETS],
            "upload_limit": f"{settings.upload_max_bytes / (1024 * 1024):.0f} MB",
        },
    )


@router.post("/projects", response_class=RedirectResponse)
async def create_project(
    request: Request,
    session: SessionDependency,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    language = _text(form, "language", "ja")
    template_id = _text(form, "template_id", "generic-ja")
    template_service = TemplateService()
    manifest = template_service.get_template(template_id)
    if language not in manifest.languages:
        template_id = "generic-en" if language == "en" else "generic-ja"
    page_target_text = _text(form, "page_target")
    page_target = _optional_integer(
        page_target_text,
        error_message="ページ数は1から1000の数値で指定してください．",
    )
    section_instructions = _parse_section_instructions(_text(form, "section_instructions"))
    paper_values: dict[str, Any] = {
        field: _text(form, field)
        for field in (
            "summary",
            "achievement",
            "key_message",
            "background",
            "problem",
            "objective",
            "novelty",
            "method",
            "system_design",
            "experimental_conditions",
            "metrics",
            "results",
            "discussion",
            "limitations",
            "conclusion",
            "future_work",
            "overall_instruction",
        )
    }
    paper_values.update(
        {
            "notes": [line.strip() for line in _text(form, "notes").splitlines() if line.strip()],
            "keywords": [
                part.strip() for part in _text(form, "keywords").split(",") if part.strip()
            ],
            "section_instructions": section_instructions,
            "selected_presets": _text_list(form, "presets"),
            "japanese_punctuation": settings.japanese_punctuation,
            "english_variant": settings.english_variant,
        }
    )
    authors = _authors_from_form(form)
    service = ProjectService(session)
    project = service.create_project(
        name=_text(form, "name"),
        title=_text(form, "title"),
        language=language,
        paper_type=_text(form, "paper_type", "research-paper"),
        research_field=_text(form, "research_field"),
        template_id=template_id,
        page_target=page_target,
        audience=_text(form, "audience"),
        venue_note=_text(form, "venue_note"),
        wizard_step=5,
        paper_spec=paper_values,
        authors=authors,
    )
    asset_service = AssetService(session, settings)
    uploads = [
        item for item in form.getlist("assets") if isinstance(item, UploadFile) and item.filename
    ]
    for upload in uploads:
        asset_service.store_upload(
            project.id,
            filename=upload.filename or "upload",
            content=upload.file,
            display_name=upload.filename,
            kind=_asset_kind(upload.filename or ""),
            description=_text(form, "asset_description"),
            purpose=_text(form, "asset_purpose"),
            target_section=_text(form, "asset_section") or None,
            source=_text(form, "asset_source"),
            is_original=bool(form.get("asset_is_original")),
            media_type=upload.content_type,
        )
    provider_name = _text(form, "provider", "rule-based")
    workflow = PaperWorkflowService(session, settings)
    if provider_name in {"ollama", "openai-compatible"}:
        # Make a useful, deterministic draft available immediately, then release
        # the request and run the potentially slow network/model call as a job.
        workflow.regenerate_outline(project.id)
        session.commit()

        async def worker(progress: Any) -> None:
            progress(JobState.GENERATING, 15, "外部生成プロバイダーで原稿を生成しています．")
            with database.session() as task_session:
                await PaperWorkflowService(task_session, settings).generate_project(
                    project.id,
                    provider_name=provider_name,
                )
            progress(JobState.RENDERING, 90, "原稿と助言を更新しています．")

        await jobs.submit(
            project.id,
            "initial-generate",
            worker,
            timeout_seconds=settings.generation_timeout_seconds,
            on_timeout=_generation_timeout_callback(
                database, settings, project.id, settings.generation_timeout_seconds
            ),
        )
    else:
        await workflow.generate_project(project.id, provider_name=provider_name)
    return RedirectResponse(f"/projects/{project.id}?created=1", status_code=303)


@router.get("/projects/{project_id}", response_class=HTMLResponse)
def project_editor(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
    section: str | None = Query(default=None),
) -> HTMLResponse:
    return _render_editor(request, project_id, session, settings, jobs, selected_slug=section)


@router.post("/projects/{project_id}/duplicate", response_class=RedirectResponse)
async def duplicate_project(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    service = ProjectService(session)
    source = service.get_project(project_id)
    duplicate = service.create_project(
        name=f"{source.name}（複製）",
        title=source.title,
        language=source.language,
        paper_type=source.paper_type,
        research_field=source.research_field,
        template_id=source.template_id,
        page_target=source.page_target,
        audience=source.audience,
        venue_note=source.venue_note,
        wizard_step=5,
        paper_spec=_stored_spec_values(source),
        authors=[
            {
                "name": author.name,
                "affiliation": author.affiliation,
                "email": author.email,
                "orcid": author.orcid,
                "corresponding": author.corresponding,
                "position": author.position,
            }
            for author in source.authors
        ],
        sections=[
            {
                "slug": section.slug,
                "title": section.title,
                "position": section.position,
                "content": section.content,
                "instruction": section.instruction,
                "generated": section.generated,
            }
            for section in source.sections
        ],
    )
    reference_service = ReferenceService(session)
    for reference in source.references:
        reference_service.create_reference(
            duplicate.id,
            citation_key=reference.citation_key,
            title=reference.title,
            authors=reference.authors,
            year=reference.year,
            venue=reference.venue,
            volume=reference.volume,
            issue=reference.issue,
            pages=reference.pages,
            doi=reference.doi,
            url=reference.url,
            note=reference.note,
            entry_type=reference.entry_type,
        )
    asset_service = AssetService(session, settings)
    for asset in source.assets:
        asset_service.store_upload(
            duplicate.id,
            filename=asset.original_filename,
            content=asset_service.read_asset(source.id, asset.id),
            display_name=asset.display_name,
            kind=asset.kind,
            description=asset.description,
            purpose=asset.purpose,
            target_section=asset.target_section,
            source=asset.source,
            is_original=asset.is_original,
            media_type=asset.media_type,
        )
    duplicate.status = "completed" if duplicate.sections else "idle"
    PaperWorkflowService(session, settings).render_current_project(duplicate.id)
    return RedirectResponse(f"/projects/{duplicate.id}", status_code=303)


@router.get("/projects/{project_id}/sections/{section_slug}", response_class=HTMLResponse)
def section_editor(
    request: Request,
    project_id: str,
    section_slug: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> HTMLResponse:
    project = ProjectService(session).get_project(project_id)
    selected = next((item for item in project.sections if item.slug == section_slug), None)
    if selected is None:
        raise NotFoundError("セクションが見つかりません．")
    response = templates.TemplateResponse(
        request=request,
        name="projects/_section_editor.html",
        context={
            "project": project_view(project),
            "selected_section": _section_view(selected, project),
            "typst_source": project.typst_source,
            "csrf_token": csrf_token(request),
            "llm_enabled": settings.generation_provider not in {"rule-based", "mock"},
            "generation_provider": settings.generation_provider,
            "external_provider": _uses_external_provider(settings),
        },
    )
    response.headers["HX-Trigger-After-Swap"] = json.dumps(
        {"paperSectionChanged": {"section": section_slug}}
    )
    return response


@router.get("/projects/{project_id}/section-list", response_class=HTMLResponse)
def section_list(
    request: Request,
    project_id: str,
    session: SessionDependency,
    section: str | None = Query(default=None),
) -> HTMLResponse:
    project = ProjectService(session).get_project(project_id)
    selected_slug = section or _current_section_slug(request)
    selected = next((item for item in project.sections if item.slug == selected_slug), None)
    return templates.TemplateResponse(
        request=request,
        name="projects/_section_list.html",
        context={
            "project": project_view(project),
            "sections": [_section_view(item, project) for item in project.sections],
            "selected_section": _section_view(selected, project) if selected else None,
        },
    )


@router.get("/projects/{project_id}/advice-panel", response_class=HTMLResponse)
def advice_panel(
    request: Request,
    project_id: str,
    session: SessionDependency,
) -> HTMLResponse:
    project = ProjectService(session).get_project(project_id)
    advice = [advice_view(item) for item in project.advice]
    return templates.TemplateResponse(
        request=request,
        name="projects/_advice.html",
        context={
            "project": project_view(project),
            "advice": advice,
            "unresolved_advice_count": sum(not item["resolved"] for item in advice),
            "csrf_token": csrf_token(request),
        },
    )


@router.post("/projects/{project_id}/authors", response_class=RedirectResponse)
async def update_authors(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    ProjectService(session).replace_authors(project_id, _authors_from_form(form))
    PaperWorkflowService(session, settings).render_current_project(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.post("/projects/{project_id}/sections/{section_slug}", response_class=HTMLResponse)
async def save_section(
    request: Request,
    project_id: str,
    section_slug: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    service = ProjectService(session)
    if form.get("create_snapshot"):
        result = service.save_section(
            project_id,
            section_slug,
            content=_raw_text(form, "content"),
            instruction=_text(form, "instruction"),
            operation="manual-save",
        )
    else:
        result = service.autosave_section(
            project_id,
            section_slug,
            content=_raw_text(form, "content"),
            instruction=_text(form, "instruction"),
        )
    if result.saved:
        PaperWorkflowService(session, settings).render_current_project(project_id)
    message = "保存済み" if result.saved else "変更なし"
    return HTMLResponse(
        f'<span class="badge badge-success">{message}</span>',
        headers={"HX-Trigger": "paperAdviceChanged"} if result.saved else None,
    )


@router.post("/projects/{project_id}/source", response_class=HTMLResponse)
async def save_source(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    PaperWorkflowService(session, settings).save_typst_source(
        project_id,
        _raw_text(form, "source"),
    )
    return HTMLResponse('<span class="badge badge-success">Typstソースを保存しました</span>')


@router.post("/projects/{project_id}/inputs", response_class=HTMLResponse)
async def save_project_inputs(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    values: dict[str, Any] = {
        field: _raw_text(form, field)
        for field in (
            "name",
            "title",
            "research_field",
            "audience",
            "venue_note",
            "summary",
            "achievement",
            "key_message",
            "background",
            "problem",
            "objective",
            "novelty",
            "method",
            "system_design",
            "experimental_conditions",
            "metrics",
            "results",
            "discussion",
            "limitations",
            "conclusion",
            "future_work",
            "overall_instruction",
        )
    }
    values.update(
        {
            "page_target": _optional_integer(
                _text(form, "page_target"),
                error_message="ページ数は1から1000の数値で指定してください．",
            ),
            "notes": [
                line.strip() for line in _raw_text(form, "notes").splitlines() if line.strip()
            ],
            "keywords": [
                item.strip() for item in _raw_text(form, "keywords").split(",") if item.strip()
            ],
            "selected_presets": _text_list(form, "presets"),
        }
    )
    result = ProjectService(session).autosave_project(project_id, values)
    if result.saved:
        PaperWorkflowService(session, settings).render_current_project(project_id)
    message = "入力情報を保存しました" if result.saved else "変更なし"
    return HTMLResponse(
        f'<span class="badge badge-success">{message}</span>',
        headers={"HX-Trigger": "paperAdviceChanged"} if result.saved else None,
    )


@router.post("/projects/{project_id}/generate", response_class=HTMLResponse)
async def generate_project(
    request: Request,
    project_id: str,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))

    async def worker(progress: Any) -> None:
        progress(JobState.GENERATING, 15, "原稿を生成しています．")
        with database.session() as task_session:
            await PaperWorkflowService(task_session, settings).generate_project(project_id)
        progress(JobState.RENDERING, 90, "画面を更新しています．")

    status = await jobs.submit(
        project_id,
        "generate",
        worker,
        timeout_seconds=settings.generation_timeout_seconds,
        on_timeout=_generation_timeout_callback(
            database, settings, project_id, settings.generation_timeout_seconds
        ),
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.post("/projects/{project_id}/translate", response_class=HTMLResponse)
async def translate_project(
    request: Request,
    project_id: str,
    session: SessionDependency,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    target_language = _text(form, "target_language")
    project = ProjectService(session).get_project(project_id)
    if target_language not in {"ja", "en"} or target_language == project.language:
        raise ValidationError("翻訳先の言語が不正です．")
    if settings.generation_provider in {"rule-based", "mock"}:
        raise ValidationError(
            "原稿全体の翻訳には設定画面でOllamaまたはOpenAI互換プロバイダーを選択してください．"
        )

    async def worker(progress: Any) -> None:
        progress(JobState.GENERATING, 15, "原稿全体を翻訳しています．")
        with database.session() as task_session:
            await PaperWorkflowService(task_session, settings).translate_project(
                project_id,
                target_language=target_language,
            )
        progress(JobState.RENDERING, 90, "翻訳した原稿を画面へ反映しています．")

    status = await jobs.submit(
        project_id,
        f"translate-to-{target_language}",
        worker,
        timeout_seconds=settings.generation_timeout_seconds,
        on_timeout=_generation_timeout_callback(
            database, settings, project_id, settings.generation_timeout_seconds
        ),
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.post("/projects/{project_id}/outline/regenerate", response_class=HTMLResponse)
async def regenerate_outline(
    request: Request,
    project_id: str,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))

    async def worker(progress: Any) -> None:
        progress(JobState.RENDERING, 35, "構成を再生成しています．")
        with database.session() as task_session:
            PaperWorkflowService(task_session, settings).regenerate_outline(project_id)
        progress(JobState.RENDERING, 90, "既存本文を保持して構成を更新しました．")

    status = await jobs.submit(
        project_id,
        "outline-regenerate",
        worker,
        timeout_seconds=settings.generation_timeout_seconds,
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.post(
    "/projects/{project_id}/sections/{section_slug}/regenerate", response_class=HTMLResponse
)
async def regenerate_section(
    request: Request,
    project_id: str,
    section_slug: str,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))

    async def worker(progress: Any) -> None:
        progress(JobState.GENERATING, 15, "セクションを再生成しています．")
        with database.session() as task_session:
            await PaperWorkflowService(task_session, settings).generate_project(
                project_id,
                target_section=section_slug,
            )
        progress(JobState.RENDERING, 90, "原稿と助言を更新しています．")

    status = await jobs.submit(
        project_id,
        "section-regenerate",
        worker,
        timeout_seconds=settings.generation_timeout_seconds,
        on_timeout=_generation_timeout_callback(
            database, settings, project_id, settings.generation_timeout_seconds
        ),
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.post(
    "/projects/{project_id}/sections/{section_slug}/transform",
    response_class=HTMLResponse,
)
async def transform_section(
    request: Request,
    project_id: str,
    section_slug: str,
    session: SessionDependency,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    operation = _text(form, "operation")
    instruction = _TRANSFORM_INSTRUCTIONS.get(operation)
    if instruction is None:
        raise ValidationError("未対応の文章変換操作です．")
    if settings.generation_provider in {"rule-based", "mock"}:
        raise ValidationError("文章変換にはOllamaまたはOpenAI互換プロバイダーの設定が必要です．")
    project = ProjectService(session).get_project(project_id)
    selected = next((item for item in project.sections if item.slug == section_slug), None)
    if selected is None:
        raise NotFoundError("文章変換の対象セクションが見つかりません．")
    selection_range = _selection_range(selected.content, form)
    expected_selection = _raw_text(form, "selected_text")

    async def worker(progress: Any) -> None:
        progress(JobState.GENERATING, 15, "選択した文章を変換しています．")
        with database.session() as task_session:
            await PaperWorkflowService(task_session, settings).generate_project(
                project_id,
                target_section=section_slug,
                instruction_override=instruction,
                allow_fallback=False,
                selection_range=selection_range,
                expected_selection=expected_selection,
            )
        progress(JobState.RENDERING, 90, "選択範囲を原稿へ反映しています．")

    status = await jobs.submit(
        project_id,
        f"selection-{operation}",
        worker,
        timeout_seconds=settings.generation_timeout_seconds,
        on_timeout=_generation_timeout_callback(
            database, settings, project_id, settings.generation_timeout_seconds
        ),
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.post("/projects/{project_id}/compile", response_class=HTMLResponse)
async def compile_project(
    request: Request,
    project_id: str,
    database: DatabaseDependency,
    settings: SettingsDependency,
    jobs: JobsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))

    async def worker(progress: Any) -> None:
        progress(JobState.COMPILING, 20, "TypstでPDFを生成しています．")
        cancellation = CompileCancellation()

        def compile_in_transaction() -> Any:
            with database.session() as task_session:
                return PaperWorkflowService(task_session, settings).compile_project(
                    project_id,
                    cancellation=cancellation,
                )

        result = await run_cancellable_compile(compile_in_transaction, cancellation)
        if not result.success:
            raise ValidationError("\n".join(result.errors))

    status = await jobs.submit(
        project_id,
        "compile",
        worker,
        timeout_seconds=settings.compile_timeout_seconds + 5.0,
    )
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )


@router.get("/jobs/{job_id}", response_class=HTMLResponse)
def job_status(request: Request, job_id: str, jobs: JobsDependency) -> HTMLResponse:
    status = jobs.get(job_id)
    response = templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
    )
    if status.state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED}:
        response.headers["HX-Refresh"] = "true"
    return response


@router.post("/jobs/{job_id}/cancel", response_class=HTMLResponse)
async def cancel_job(request: Request, job_id: str, jobs: JobsDependency) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    status = await jobs.cancel(job_id)
    return templates.TemplateResponse(
        request=request,
        name="projects/_job.html",
        context={"job": job_view(status), "csrf_token": csrf_token(request)},
        headers={"HX-Refresh": "true"},
    )


@router.post("/projects/{project_id}/advice/{advice_id}/resolve", response_class=HTMLResponse)
async def resolve_advice(
    request: Request,
    project_id: str,
    advice_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> HTMLResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    item = PaperWorkflowService(session, settings).resolve_advice(project_id, advice_id)
    return HTMLResponse(
        f'<article class="advice optional"><span class="badge badge-success">解決済み</span><h3>{html.escape(item.title)}</h3></article>',
        headers={"HX-Trigger": "paperAdviceChanged"},
    )


@router.post("/projects/{project_id}/assets", response_class=RedirectResponse)
async def upload_asset(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    upload = form.get("file")
    if not isinstance(upload, UploadFile) or not upload.filename:
        raise ValidationError("アップロードするファイルを選択してください．")
    AssetService(session, settings).store_upload(
        project_id,
        filename=upload.filename,
        content=upload.file,
        display_name=upload.filename,
        kind=_text(form, "kind") or _asset_kind(upload.filename),
        description=_text(form, "description"),
        purpose=_text(form, "purpose"),
        target_section=_text(form, "target_section") or None,
        source=_text(form, "source"),
        is_original=bool(form.get("is_original")),
        media_type=upload.content_type,
    )
    PaperWorkflowService(session, settings).refresh_advice(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.get("/projects/{project_id}/assets/{asset_id}")
def download_asset(
    project_id: str,
    asset_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> Response:
    service = AssetService(session, settings)
    asset = service.get_asset(project_id, asset_id)
    data = service.read_asset(project_id, asset_id)
    encoded_name = quote(asset.original_filename, safe="")
    return Response(
        content=data,
        media_type=asset.media_type or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.post("/projects/{project_id}/references", response_class=RedirectResponse)
async def add_reference(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    year_text = _text(form, "year")
    ReferenceService(session).create_reference(
        project_id,
        citation_key=_text(form, "citation_key"),
        title=_text(form, "title"),
        authors=[part.strip() for part in _text(form, "authors").split(";") if part.strip()],
        year=_optional_integer(
            year_text,
            error_message="年は4桁の数値で指定してください．",
        ),
        venue=_text(form, "venue"),
        volume=_text(form, "volume"),
        issue=_text(form, "issue"),
        pages=_text(form, "pages"),
        doi=_text(form, "doi"),
        url=_text(form, "url"),
        note=_text(form, "note"),
        entry_type=_text(form, "entry_type", "article"),
    )
    PaperWorkflowService(session, settings).render_current_project(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.post(
    "/projects/{project_id}/assets/{asset_id}/update",
    response_class=RedirectResponse,
)
async def update_asset(
    request: Request,
    project_id: str,
    asset_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    AssetService(session, settings).update_metadata(
        project_id,
        asset_id,
        {
            "display_name": _text(form, "display_name"),
            "kind": _text(form, "kind", "other"),
            "description": _text(form, "description"),
            "purpose": _text(form, "purpose"),
            "target_section": _text(form, "target_section"),
            "source": _text(form, "source"),
            "is_original": bool(form.get("is_original")),
        },
    )
    PaperWorkflowService(session, settings).refresh_advice(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.post(
    "/projects/{project_id}/assets/{asset_id}/delete",
    response_class=RedirectResponse,
)
async def delete_asset(
    request: Request,
    project_id: str,
    asset_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    AssetService(session, settings).remove_asset(project_id, asset_id)
    PaperWorkflowService(session, settings).refresh_advice(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.post("/projects/{project_id}/references/import", response_class=RedirectResponse)
async def import_references(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    source = _raw_text(form, "bibtex")
    upload = form.get("file")
    if isinstance(upload, UploadFile) and upload.filename:
        raw = await upload.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValidationError("BibTeXファイルは2 MB以下にしてください．")
        try:
            source = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValidationError("BibTeXファイルはUTF-8で保存してください．") from exc
    if not source.strip():
        raise ValidationError("BibTeXを貼り付けるかファイルを選択してください．")
    result = ReferenceService(session).import_bibtex(project_id, source)
    PaperWorkflowService(session, settings).render_current_project(project_id)
    query = (
        f"reference_created={len(result.created)}&"
        f"reference_duplicates={len(result.duplicate_keys)}&"
        f"reference_errors={len(result.errors)}"
    )
    return RedirectResponse(f"/projects/{project_id}?{query}", status_code=303)


@router.post(
    "/projects/{project_id}/references/{reference_id}/update",
    response_class=RedirectResponse,
)
async def update_reference(
    request: Request,
    project_id: str,
    reference_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    ReferenceService(session).update_reference(
        project_id,
        reference_id,
        {
            "citation_key": _text(form, "citation_key"),
            "entry_type": _text(form, "entry_type", "article"),
            "title": _text(form, "title"),
            "authors": [item.strip() for item in _text(form, "authors").split(";") if item.strip()],
            "year": _optional_integer(
                _text(form, "year"),
                error_message="年は4桁の数値で指定してください．",
            ),
            "venue": _text(form, "venue"),
            "volume": _text(form, "volume"),
            "issue": _text(form, "issue"),
            "pages": _text(form, "pages"),
            "doi": _text(form, "doi"),
            "url": _text(form, "url"),
            "note": _text(form, "note"),
        },
    )
    PaperWorkflowService(session, settings).render_current_project(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.post(
    "/projects/{project_id}/references/{reference_id}/delete",
    response_class=RedirectResponse,
)
async def delete_reference(
    request: Request,
    project_id: str,
    reference_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    ReferenceService(session).delete_reference(project_id, reference_id)
    PaperWorkflowService(session, settings).render_current_project(project_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


@router.get("/projects/{project_id}/references.bib")
def export_references_bib(project_id: str, session: SessionDependency) -> PlainTextResponse:
    content = ReferenceService(session).export_bibtex(project_id)
    return PlainTextResponse(
        content,
        media_type="application/x-bibtex; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="references.bib"'},
    )


@router.get("/projects/{project_id}/references.yml")
def export_references_yaml(project_id: str, session: SessionDependency) -> PlainTextResponse:
    content = ReferenceService(session).export_hayagriva_yaml(project_id)
    return PlainTextResponse(
        content,
        media_type="application/yaml; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="references.yml"'},
    )


@router.get("/projects/{project_id}/pdf")
def download_pdf(
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> FileResponse:
    project = ProjectService(session).get_project(project_id, aggregate=False)
    if not project.pdf_relative_path:
        raise NotFoundError("PDFはまだ生成されていません．")
    root = PaperWorkflowService(session, settings).project_directory(project_id)
    try:
        pdf = resolve_within(root, project.pdf_relative_path, must_exist=True)
    except (OSError, ValidationError) as exc:
        raise NotFoundError("PDFが見つかりません．") from exc
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        raise NotFoundError("PDFが見つかりません．")
    return FileResponse(pdf, media_type="application/pdf", filename=f"{project.name}.pdf")


@router.get("/projects/{project_id}/source")
def download_source(project_id: str, session: SessionDependency) -> PlainTextResponse:
    project = ProjectService(session).get_project(project_id, aggregate=False)
    return PlainTextResponse(
        project.typst_source,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="main.typ"'},
    )


@router.get("/projects/{project_id}/export")
def export_project(
    project_id: str, session: SessionDependency, settings: SettingsDependency
) -> Response:
    project = ProjectService(session).get_project(project_id, aggregate=False)
    data = ExportService(session, settings).build_zip(project_id)
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", project.name).strip("-.") or "paper"
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.zip"'},
    )


@router.get("/projects/{project_id}/delete", response_class=HTMLResponse)
def delete_confirmation(
    request: Request, project_id: str, session: SessionDependency
) -> HTMLResponse:
    project = ProjectService(session).get_project(project_id, aggregate=False)
    return templates.TemplateResponse(
        request=request,
        name="projects/delete.html",
        context={
            "active_page": "projects",
            "project": project_view(project),
            "csrf_token": csrf_token(request),
        },
    )


@router.post("/projects/{project_id}/delete", response_class=RedirectResponse)
async def delete_project(
    request: Request,
    project_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    workflow = PaperWorkflowService(session, settings)
    project_dir = workflow.project_directory(project_id)
    ProjectService(session).delete_project(project_id)
    if project_dir.is_dir():
        trash = (settings.data_dir / "trash").resolve()
        trash.mkdir(parents=True, exist_ok=True)
        destination = trash / f"{project_id}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"
        os.replace(project_dir, destination)
    return RedirectResponse("/projects", status_code=303)


@router.post(
    "/projects/{project_id}/versions/{version_id}/restore", response_class=RedirectResponse
)
async def restore_version(
    request: Request,
    project_id: str,
    version_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    version = session.get(SectionVersion, version_id)
    if version is None:
        raise NotFoundError("復元する版が見つかりません．")
    section = session.get(Section, version.section_id)
    if section is None or section.project_id != project_id:
        raise NotFoundError("復元する版が見つかりません．")
    ProjectService(session).restore_section_version(project_id, section.slug, version_id)
    PaperWorkflowService(session, settings).render_current_project(project_id)
    return RedirectResponse(f"/projects/{project_id}?section={section.slug}", status_code=303)


@router.post(
    "/projects/{project_id}/runs/{run_id}/restore-source",
    response_class=RedirectResponse,
)
async def restore_source_version(
    request: Request,
    project_id: str,
    run_id: str,
    session: SessionDependency,
    settings: SettingsDependency,
) -> RedirectResponse:
    form = await request.form()
    validate_csrf(request, _text(form, "csrf_token"))
    PaperWorkflowService(session, settings).restore_source_snapshot(project_id, run_id)
    return RedirectResponse(f"/projects/{project_id}", status_code=303)


def _render_editor(
    request: Request,
    project_id: str,
    session: Session,
    settings: AppSettings,
    jobs: JobManager,
    *,
    selected_slug: str | None,
) -> HTMLResponse:
    project = ProjectService(session).get_project(project_id)
    selected = next((item for item in project.sections if item.slug == selected_slug), None)
    if selected_slug is not None and selected is None:
        raise NotFoundError("セクションが見つかりません．")
    if selected is None and project.sections:
        selected = project.sections[0]
    used_keys = {
        key.rstrip(".,;:!?，．、。")
        for key in _CITATION_RE.findall(project.typst_source)
        if key.rstrip(".,;:!?，．、。")
    }
    advice = [advice_view(item) for item in project.advice]
    reference_service = ReferenceService(session)
    usage = reference_service.analyze_usage(project.id, used_keys)
    used_keys_folded = {key.casefold() for key in used_keys}
    references = [
        reference_view(item, used=item.citation_key.casefold() in used_keys_folded)
        for item in reference_service.list_references(project.id)
    ]
    versions = [
        version_view(
            version,
            section_title=section.title,
            current_content=section.content,
        )
        for section in project.sections
        for version in section.versions[:5]
    ]
    versions.sort(key=lambda item: item["created_at_display"], reverse=True)
    generation_runs = [
        generation_run_view(run, current_source=project.typst_source)
        for run in sorted(project.generation_runs, key=lambda item: item.created_at, reverse=True)
    ]
    workflow = PaperWorkflowService(session, settings)
    project_dir = workflow.project_directory(project.id)
    has_pdf = bool(
        project.pdf_relative_path and (project_dir / project.pdf_relative_path).is_file()
    )
    latest_compile = max(project.compile_results, key=lambda item: item.created_at, default=None)
    compile_errors = (
        [str(error) for error in latest_compile.errors]
        if latest_compile is not None and not latest_compile.success
        else []
    )
    current_job = jobs.current_for_project(project.id)
    return templates.TemplateResponse(
        request=request,
        name="projects/editor.html",
        context={
            "active_page": "projects",
            "csrf_token": csrf_token(request),
            "project": project_view(project),
            "sections": [_section_view(item, project) for item in project.sections],
            "selected_section": _section_view(selected, project) if selected else None,
            "typst_source": project.typst_source,
            "advice": advice,
            "unresolved_advice_count": sum(not item["resolved"] for item in advice),
            "assets": [asset_view(item) for item in project.assets],
            "references": references,
            "missing_reference_keys": usage.missing_keys,
            "reference_import": {
                "created": request.query_params.get("reference_created"),
                "duplicates": request.query_params.get("reference_duplicates"),
                "errors": request.query_params.get("reference_errors"),
            },
            "versions": versions[:30],
            "generation_runs": generation_runs[:30],
            "typst_available": workflow.compiler.is_available(),
            "has_pdf": has_pdf,
            "compile_errors": compile_errors,
            "pdf_revision": int(project.updated_at.timestamp()),
            "job": job_view(current_job) if current_job else None,
            "paper_inputs": _paper_inputs(project),
            "authors": [
                {
                    "name": author.name,
                    "affiliation": author.affiliation,
                    "email": author.email,
                    "orcid": author.orcid,
                    "corresponding": author.corresponding,
                }
                for author in project.authors
            ],
            "presets": [{"id": item[0], "label": item[1]} for item in _PRESETS],
            "llm_enabled": settings.generation_provider not in {"rule-based", "mock"},
            "generation_provider": settings.generation_provider,
            "external_provider": _uses_external_provider(settings),
        },
    )


def _section_view(section: Section, project: Any) -> dict[str, Any]:
    if not section.content.strip():
        completion_label = "未生成"
        completion_class = "badge-required"
    elif _PLACEHOLDER_MARKER_RE.search(section.content):
        completion_label = "要追記"
        completion_class = "badge-warning"
    else:
        completion_label = "本文あり"
        completion_class = "badge-success"
    return {
        "id": section.slug,
        "database_id": section.id,
        "title": section.title,
        "position": section.position,
        "content": section.content,
        "instruction": section.instruction,
        "completion_label": completion_label,
        "completion_class": completion_class,
        "advice_count": sum(
            not item.resolved and item.target_section == section.slug for item in project.advice
        ),
    }


def _current_section_slug(request: Request) -> str | None:
    current_url = request.headers.get("HX-Current-URL", "")
    if not current_url:
        return None
    try:
        return parse_qs(urlsplit(current_url).query).get("section", [None])[0]
    except ValueError:
        return None


def _uses_external_provider(settings: AppSettings) -> bool:
    if settings.generation_provider == "openai-compatible":
        return True
    if settings.generation_provider != "ollama":
        return False
    try:
        hostname = urlsplit(settings.ollama_url).hostname
    except ValueError:
        return True
    return hostname not in {"localhost", "127.0.0.1", "::1"}


def _text(form: FormData, key: str, default: str = "") -> str:
    value = form.get(key, default)
    return value.strip() if isinstance(value, str) else default


def _raw_text(form: FormData, key: str, default: str = "") -> str:
    value = form.get(key, default)
    return value if isinstance(value, str) else default


def _optional_integer(value: str, *, error_message: str) -> int | None:
    if not value:
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValidationError(error_message) from exc


def _selection_range(content: str, form: FormData) -> tuple[int, int]:
    raw_start = _raw_text(form, "selection_start")
    raw_end = _raw_text(form, "selection_end")
    selected_text = _raw_text(form, "selected_text")
    try:
        start_utf16 = int(raw_start)
        end_utf16 = int(raw_end)
    except ValueError as exc:
        raise ValidationError("文章変換の選択範囲が不正です．") from exc
    start = _utf16_offset_to_index(content, start_utf16)
    end = _utf16_offset_to_index(content, end_utf16)
    if start is None or end is None or end <= start:
        raise ValidationError("変換する文章を選択してください．")
    actual = content[start:end]
    if actual != selected_text:
        raise ValidationError("本文の保存完了後に，変換する文章をもう一度選択してください．")
    if not actual.strip():
        raise ValidationError("変換する文章を選択してください．")
    if len(actual) > _MAX_TRANSFORM_SELECTION_CHARS:
        raise ValidationError("選択範囲が長すぎます．10万文字以内で指定してください．")
    return start, end


def _utf16_offset_to_index(text: str, offset: int) -> int | None:
    """Convert browser textarea offsets (UTF-16 units) to Python indexes."""

    if offset < 0:
        return None
    units = 0
    for index, character in enumerate(text):
        if units == offset:
            return index
        units += 2 if ord(character) > 0xFFFF else 1
        if units > offset:
            return None
    return len(text) if units == offset else None


def _text_list(form: FormData, key: str) -> list[str]:
    return [
        value.strip() for value in form.getlist(key) if isinstance(value, str) and value.strip()
    ]


def _authors_from_form(form: FormData) -> list[dict[str, Any]]:
    names = _text_list_preserve_empty(form, "author_name")
    affiliations = _text_list_preserve_empty(form, "author_affiliation")
    emails = _text_list_preserve_empty(form, "author_email")
    orcids = _text_list_preserve_empty(form, "author_orcid")
    corresponding_indices = {
        int(value)
        for value in form.getlist("author_corresponding")
        if isinstance(value, str) and value.isdigit()
    }
    authors: list[dict[str, Any]] = []
    for source_index, name in enumerate(names):
        if not name:
            continue
        authors.append(
            {
                "name": name,
                "affiliation": (
                    affiliations[source_index] if source_index < len(affiliations) else ""
                ),
                "email": emails[source_index] if source_index < len(emails) else "",
                "orcid": orcids[source_index] if source_index < len(orcids) else "",
                "corresponding": source_index in corresponding_indices,
                "position": len(authors),
            }
        )
    return authors


def _text_list_preserve_empty(form: FormData, key: str) -> list[str]:
    return [value.strip() if isinstance(value, str) else "" for value in form.getlist(key)]


def _parse_section_instructions(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in value.splitlines():
        key, separator, instruction = line.partition(":")
        if separator and key.strip() and instruction.strip():
            result[key.strip()] = instruction.strip()
    return result


def _paper_inputs(project: Any) -> dict[str, Any]:
    spec = project.paper_spec
    values: dict[str, Any] = {
        "name": project.name,
        "title": project.title,
        "research_field": project.research_field,
        "audience": project.audience,
        "venue_note": project.venue_note,
        "page_target": project.page_target,
    }
    fields = (
        "summary",
        "achievement",
        "key_message",
        "background",
        "problem",
        "objective",
        "novelty",
        "method",
        "system_design",
        "experimental_conditions",
        "metrics",
        "results",
        "discussion",
        "limitations",
        "conclusion",
        "future_work",
        "overall_instruction",
    )
    values.update({field: getattr(spec, field, "") if spec is not None else "" for field in fields})
    values["notes"] = "\n".join(spec.notes) if spec is not None else ""
    values["keywords"] = ", ".join(spec.keywords) if spec is not None else ""
    values["selected_presets"] = list(spec.selected_presets) if spec is not None else []
    return values


def _stored_spec_values(project: Any) -> dict[str, Any]:
    spec = project.paper_spec
    if spec is None:
        return {}
    fields = (
        "summary",
        "notes",
        "achievement",
        "key_message",
        "background",
        "problem",
        "objective",
        "novelty",
        "method",
        "system_design",
        "experimental_conditions",
        "metrics",
        "results",
        "discussion",
        "limitations",
        "conclusion",
        "future_work",
        "keywords",
        "overall_instruction",
        "section_instructions",
        "selected_presets",
        "japanese_punctuation",
        "english_variant",
    )
    return {field: getattr(spec, field) for field in fields}


def _asset_kind(filename: str) -> str:
    extension = os.path.splitext(filename)[1].casefold()
    if extension in {".png", ".jpg", ".jpeg", ".svg"}:
        return "figure"
    if extension in {".csv", ".json", ".txt", ".yml", ".yaml"}:
        return "data"
    return "other"
