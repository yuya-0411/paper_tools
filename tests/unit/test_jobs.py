from __future__ import annotations

import asyncio
import threading

import pytest

from paper_tools.exceptions import ConflictError
from paper_tools.services.jobs import JobManager, JobState
from paper_tools.services.typst_compiler import (
    CompileCancellation,
    CompileCancelledError,
    run_cancellable_compile,
)


@pytest.mark.anyio
async def test_job_manager_tracks_progress_and_prevents_duplicates() -> None:
    manager = JobManager(timeout_seconds=1)
    started = asyncio.Event()
    release = asyncio.Event()

    async def worker(progress: object) -> None:
        callback = progress
        assert callable(callback)
        callback(JobState.GENERATING, 40, "生成中")
        started.set()
        await release.wait()

    status = await manager.submit("project-1", "generate", worker)
    await started.wait()
    assert manager.get(status.id).progress == 40
    with pytest.raises(ConflictError):
        await manager.submit("project-1", "compile", worker)
    release.set()
    completed = await manager.wait(status.id)
    assert completed.state is JobState.COMPLETED
    assert completed.progress == 100


@pytest.mark.anyio
async def test_job_manager_timeout_and_cancel() -> None:
    manager = JobManager(timeout_seconds=0.01)

    async def slow(_progress: object) -> None:
        await asyncio.sleep(1)

    timed = await manager.submit("project-1", "slow", slow)
    assert (await manager.wait(timed.id)).state is JobState.FAILED

    manager = JobManager(timeout_seconds=1)
    cancelled = await manager.submit("project-2", "cancel", slow)
    assert (await manager.cancel(cancelled.id)).state is JobState.CANCELLED


@pytest.mark.anyio
async def test_job_specific_timeout_override_and_persistence_callback() -> None:
    manager = JobManager(timeout_seconds=0.01)
    persisted = asyncio.Event()

    async def short(_progress: object) -> None:
        await asyncio.sleep(0.03)

    async def persist_timeout() -> None:
        persisted.set()

    completed = await manager.submit(
        "project-override",
        "compile",
        short,
        timeout_seconds=0.2,
    )
    assert (await manager.wait(completed.id)).state is JobState.COMPLETED

    timed = await manager.submit(
        "project-timeout",
        "generate",
        short,
        timeout_seconds=0.01,
        on_timeout=persist_timeout,
    )
    timed_status = await manager.wait(timed.id)
    assert timed_status.state is JobState.FAILED
    assert timed_status.error == "timeout"
    assert persisted.is_set()


@pytest.mark.anyio
async def test_shutdown_waits_for_compile_cancellation_cleanup() -> None:
    manager = JobManager(timeout_seconds=5)
    cancellation = CompileCancellation()
    started = threading.Event()
    cleaned_up = threading.Event()

    def blocking_compile() -> None:
        started.set()
        while not cancellation.cancelled:
            threading.Event().wait(0.01)
        cleaned_up.set()
        raise CompileCancelledError

    async def worker(_progress: object) -> None:
        await run_cancellable_compile(blocking_compile, cancellation)

    job = await manager.submit("project-shutdown", "compile", worker)
    assert await asyncio.to_thread(started.wait, 1)

    await manager.shutdown()

    assert cleaned_up.is_set()
    assert manager.get(job.id).state is JobState.CANCELLED


@pytest.mark.anyio
async def test_cancel_after_success_is_sealed_finishes_as_completed() -> None:
    manager = JobManager(timeout_seconds=5)
    cancellation = CompileCancellation()
    sealed = threading.Event()
    release_commit = threading.Event()

    def finishing_compile() -> str:
        assert cancellation.seal_success()
        sealed.set()
        assert release_commit.wait(timeout=2)
        return "committed"

    async def worker(_progress: object) -> None:
        result = await run_cancellable_compile(finishing_compile, cancellation)
        assert result == "committed"

    job = await manager.submit("project-sealed", "compile", worker)
    assert await asyncio.to_thread(sealed.wait, 1)
    cancel_task = asyncio.create_task(manager.cancel(job.id))
    await asyncio.sleep(0)
    release_commit.set()

    status = await cancel_task

    assert status.state is JobState.COMPLETED
