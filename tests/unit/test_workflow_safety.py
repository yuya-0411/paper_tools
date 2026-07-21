from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.models import ApplicationSetting, GenerationRun
from paper_tools.providers import (
    FallbackProvider,
    OllamaProvider,
    OpenAICompatibleProvider,
    RuleBasedProvider,
)
from paper_tools.schemas import CompileResult, CompileStatus
from paper_tools.services.projects import ProjectService
from paper_tools.services.workflow import PaperWorkflowService


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


def test_successful_recompile_advances_project_pdf_revision(
    workflow_context: tuple[Session, AppSettings],
) -> None:
    session, settings = workflow_context
    project = ProjectService(session).create_project(name="Compile revision")
    project.typst_source = "= Compile revision\n"
    project.pdf_relative_path = "output/paper.pdf"
    session.flush()
    previous_revision = datetime(2000, 1, 1, tzinfo=UTC)
    project.updated_at = previous_revision
    session.flush()

    class SuccessfulCompiler:
        def compile(self, *_args: object, **_kwargs: object) -> CompileResult:
            return CompileResult(
                status=CompileStatus.SUCCESS,
                success=True,
                output_path="output/paper.pdf",
            )

    workflow = PaperWorkflowService(session, settings)
    workflow.compiler = SuccessfulCompiler()  # type: ignore[assignment]

    result = workflow.compile_project(project.id)

    assert result.success
    assert project.pdf_relative_path == "output/paper.pdf"
    assert project.updated_at > previous_revision


@pytest.mark.parametrize(
    ("provider_name", "provider_type"),
    [
        ("ollama", OllamaProvider),
        ("openai-compatible", OpenAICompatibleProvider),
    ],
)
def test_external_provider_fallback_can_be_disabled(
    workflow_context: tuple[Session, AppSettings],
    provider_name: str,
    provider_type: type[object],
) -> None:
    session, settings = workflow_context
    workflow = PaperWorkflowService(session, settings)

    direct = workflow.create_provider(provider_name, allow_fallback=False)
    default = workflow.create_provider(provider_name)

    assert isinstance(direct, provider_type)
    assert isinstance(default, FallbackProvider)


def test_generate_project_forwards_disabled_fallback_to_provider_factory(
    workflow_context: tuple[Session, AppSettings],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session, settings = workflow_context
    project = ProjectService(session).create_project(name="No transform fallback")
    calls: list[tuple[str | None, bool]] = []

    def recording_factory(
        _workflow: PaperWorkflowService,
        name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> RuleBasedProvider:
        calls.append((name, allow_fallback))
        return RuleBasedProvider()

    monkeypatch.setattr(PaperWorkflowService, "create_provider", recording_factory)
    workflow = PaperWorkflowService(session, settings)

    asyncio.run(
        workflow.generate_project(
            project.id,
            provider_name="ollama",
            allow_fallback=False,
        )
    )

    assert calls == [("ollama", False)]


def test_generation_provider_wait_releases_sqlite_write_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = AppSettings(data_dir=tmp_path / "concurrent-state", _env_file=None)
    database = Database(settings)
    database.initialize()
    with database.session() as setup_session:
        project_id = ProjectService(setup_session).create_project(name="Long provider wait").id

    started = asyncio.Event()
    release = asyncio.Event()

    class WaitingProvider:
        name = "waiting-provider"

        async def generate(self, request: object) -> object:
            started.set()
            await release.wait()
            return await RuleBasedProvider().generate(request)  # type: ignore[arg-type]

    provider = WaitingProvider()

    def provider_factory(
        _workflow: PaperWorkflowService,
        _name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> WaitingProvider:
        assert allow_fallback
        return provider

    monkeypatch.setattr(PaperWorkflowService, "create_provider", provider_factory)

    async def scenario() -> None:
        generation_session = database.session_factory()
        try:
            task = asyncio.create_task(
                PaperWorkflowService(generation_session, settings).generate_project(project_id)
            )
            await started.wait()
            with database.session() as concurrent_session:
                running = concurrent_session.scalar(
                    select(GenerationRun).where(GenerationRun.project_id == project_id)
                )
                assert running is not None and running.status == "generating"
                concurrent_session.add(
                    ApplicationSetting(key="concurrent-write", value={"ok": True})
                )
            release.set()
            await task
            generation_session.commit()
        finally:
            generation_session.close()

    asyncio.run(scenario())
    database.dispose()


def test_generation_timeout_is_persisted_as_failed(
    workflow_context: tuple[Session, AppSettings],
) -> None:
    session, settings = workflow_context
    project = ProjectService(session).create_project(name="Timed out generation")
    project.status = "cancelled"
    run = GenerationRun(
        project_id=project.id,
        operation="generate",
        provider="test-provider",
        status="cancelled",
        message="cancelled by outer timeout",
    )
    session.add(run)
    session.flush()

    PaperWorkflowService(session, settings).mark_generation_timeout(
        project.id,
        timeout_seconds=12.5,
    )

    assert project.status == "failed"
    assert run.status == "failed"
    assert run.error_message == "timeout after 12.5 seconds"
    assert "タイムアウト" in run.message
