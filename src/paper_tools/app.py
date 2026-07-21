"""FastAPI application factory for local and laboratory use."""

from __future__ import annotations

import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import update
from starlette.middleware.base import RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware

from paper_tools import __version__
from paper_tools.config import RUNTIME_SETTING_FIELDS, AppSettings, get_settings
from paper_tools.database import Database
from paper_tools.exceptions import NotFoundError, PaperToolsError
from paper_tools.models import ApplicationSetting, GenerationRun, Project
from paper_tools.services.jobs import JobManager
from paper_tools.web.routes import router
from paper_tools.web.templating import templates

logger = logging.getLogger(__name__)


def create_app(
    settings: AppSettings | None = None,
    *,
    database: Database | None = None,
) -> FastAPI:
    selected_settings = settings or get_settings()
    selected_database = database or Database(selected_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            selected_settings.ensure_directories()
            selected_database.initialize()
            with selected_database.session() as session:
                persisted = session.get(ApplicationSetting, "runtime")
                if persisted is not None:
                    # Explicit constructor, environment, and .env values take
                    # precedence over UI-persisted defaults.
                    persisted_values: Any = persisted.value
                    if not isinstance(persisted_values, dict):
                        logger.warning("Ignoring non-object persisted runtime settings")
                        persisted.value = {}
                        persisted_values = {}
                    overrides = {
                        key: value
                        for key, value in persisted_values.items()
                        if key in RUNTIME_SETTING_FIELDS
                        and key not in selected_settings.model_fields_set
                    }
                    try:
                        candidate_values = selected_settings.model_dump()
                        candidate_values.update(overrides)
                        candidate = AppSettings(**candidate_values)
                    except PydanticValidationError as exc:
                        logger.warning(
                            "Ignoring invalid persisted runtime settings: %s",
                            exc,
                        )
                        # Keep the row for auditability while quarantining the
                        # invalid payload so a later restart is also safe.
                        persisted.value = {}
                    else:
                        for key in overrides:
                            setattr(selected_settings, key, getattr(candidate, key))
                        app.state.jobs.timeout_seconds = (
                            selected_settings.generation_timeout_seconds
                        )
                interrupted_states = ("planning", "generating", "rendering", "compiling")
                session.execute(
                    update(GenerationRun)
                    .where(GenerationRun.status.in_(interrupted_states))
                    .values(
                        status="failed",
                        message="アプリ再起動により処理を終了しました．",
                        error_message="interrupted by application restart",
                    )
                )
                session.execute(
                    update(Project)
                    .where(Project.status.in_(interrupted_states))
                    .values(status="failed")
                )
            yield
        finally:
            await app.state.jobs.shutdown()
            selected_database.dispose()

    app = FastAPI(
        title="paper_tools",
        description="ローカルファーストのTypst論文作成支援Webアプリケーション",
        version=__version__,
        docs_url="/api/docs" if selected_settings.debug else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = selected_settings
    app.state.database = selected_database
    app.state.jobs = JobManager(timeout_seconds=selected_settings.generation_timeout_seconds)
    static_dir = Path(__file__).resolve().parent / "web" / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    allowed_hosts = ["127.0.0.1", "localhost", "testserver"]
    if selected_settings.host not in {"0.0.0.0", "::"}:
        allowed_hosts.append(selected_settings.host)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(dict.fromkeys(allowed_hosts)))

    @app.middleware("http")
    async def security_headers(
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        token = request.cookies.get("paper_tools_csrf")
        new_token = not token or len(token) < 32
        if new_token:
            token = secrets.token_urlsafe(32)
        assert token is not None
        request.state.csrf_token = token
        response = await call_next(request)
        if new_token:
            response.set_cookie(
                "paper_tools_csrf",
                token,
                httponly=True,
                samesite="strict",
                secure=False,
                path="/",
            )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; "
            "img-src 'self' data:; frame-src 'self'; object-src 'self'; base-uri 'none'; "
            "form-action 'self'; frame-ancestors 'self'"
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        """Return a small, non-sensitive identity check for local launchers."""

        return {"app": "paper_tools", "status": "ok", "version": __version__}

    @app.exception_handler(PaperToolsError)
    async def paper_tools_error(request: Request, exc: PaperToolsError) -> HTMLResponse:
        status_code = 404 if isinstance(exc, NotFoundError) else 400
        return templates.TemplateResponse(
            request=request,
            name="error.html",
            context={
                "status_code": status_code,
                "title": "対象が見つかりません"
                if status_code == 404
                else "操作を完了できませんでした",
                "message": str(exc),
                "active_page": "",
            },
            status_code=status_code,
        )

    app.include_router(router)
    return app


__all__ = ["create_app"]
