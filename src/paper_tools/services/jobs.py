"""Small in-process job manager used by HTMX polling views."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from paper_tools.exceptions import ConflictError, NotFoundError


class JobState(StrEnum):
    IDLE = "idle"
    PLANNING = "planning"
    GENERATING = "generating"
    RENDERING = "rendering"
    COMPILING = "compiling"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class JobStatus:
    id: str
    project_id: str
    operation: str
    state: JobState
    progress: int
    message: str
    created_at: datetime
    updated_at: datetime
    error: str | None = None


ProgressCallback = Callable[[JobState, int, str], None]
JobWorker = Callable[[ProgressCallback], Awaitable[Any]]
TimeoutCallback = Callable[[], Awaitable[None]]


class JobManager:
    """Run at most one mutating job per project without a distributed queue."""

    def __init__(self, *, timeout_seconds: float = 300.0) -> None:
        self.timeout_seconds = timeout_seconds
        self._statuses: dict[str, JobStatus] = {}
        self._project_jobs: dict[str, str] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._guard = asyncio.Lock()

    async def submit(
        self,
        project_id: str,
        operation: str,
        worker: JobWorker,
        *,
        timeout_seconds: float | None = None,
        on_timeout: TimeoutCallback | None = None,
    ) -> JobStatus:
        selected_timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        if selected_timeout <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        async with self._guard:
            current_id = self._project_jobs.get(project_id)
            if current_id and self._statuses[current_id].state not in {
                JobState.COMPLETED,
                JobState.FAILED,
                JobState.CANCELLED,
            }:
                raise ConflictError("このプロジェクトでは別の処理を実行中です．")
            now = datetime.now(UTC)
            job_id = uuid.uuid4().hex
            status = JobStatus(
                id=job_id,
                project_id=project_id,
                operation=operation,
                state=JobState.PLANNING,
                progress=0,
                message="処理を準備しています．",
                created_at=now,
                updated_at=now,
            )
            self._statuses[job_id] = status
            self._project_jobs[project_id] = job_id
            self._tasks[job_id] = asyncio.create_task(
                self._run(job_id, worker, selected_timeout, on_timeout)
            )
            return status

    def get(self, job_id: str) -> JobStatus:
        try:
            return self._statuses[job_id]
        except KeyError as exc:
            raise NotFoundError("処理状態が見つかりません．") from exc

    def current_for_project(self, project_id: str) -> JobStatus | None:
        job_id = self._project_jobs.get(project_id)
        return self._statuses.get(job_id) if job_id else None

    async def cancel(self, job_id: str) -> JobStatus:
        task = self._tasks.get(job_id)
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        status = self.get(job_id)
        if status.state not in {JobState.COMPLETED, JobState.FAILED}:
            self._set(job_id, state=JobState.CANCELLED, message="処理を取り消しました．")
        return self.get(job_id)

    async def wait(self, job_id: str) -> JobStatus:
        task = self._tasks.get(job_id)
        if task:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return self.get(job_id)

    async def shutdown(self) -> None:
        active = [task for task in self._tasks.values() if not task.done()]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)

    async def _run(
        self,
        job_id: str,
        worker: JobWorker,
        timeout_seconds: float,
        on_timeout: TimeoutCallback | None,
    ) -> None:
        def progress(state: JobState, percent: int, message: str) -> None:
            self._set(
                job_id,
                state=state,
                progress=max(0, min(100, percent)),
                message=message,
            )

        try:
            async with asyncio.timeout(timeout_seconds):
                await worker(progress)
            self._set(
                job_id,
                state=JobState.COMPLETED,
                progress=100,
                message="処理が完了しました．",
            )
        except asyncio.CancelledError:
            self._set(job_id, state=JobState.CANCELLED, message="処理を取り消しました．")
            raise
        except TimeoutError:
            persistence_error: str | None = None
            if on_timeout is not None:
                try:
                    await on_timeout()
                except Exception as exc:  # the in-memory terminal state must still be sealed
                    persistence_error = str(exc)[:1000]
            self._set(
                job_id,
                state=JobState.FAILED,
                message="処理がタイムアウトしました．",
                error=(
                    f"timeout; 状態保存にも失敗しました: {persistence_error}"
                    if persistence_error
                    else "timeout"
                ),
            )
        except Exception as exc:
            self._set(
                job_id,
                state=JobState.FAILED,
                message="処理に失敗しました．",
                error=str(exc),
            )

    def _set(
        self,
        job_id: str,
        *,
        state: JobState | None = None,
        progress: int | None = None,
        message: str | None = None,
        error: str | None = None,
    ) -> None:
        current = self._statuses[job_id]
        self._statuses[job_id] = JobStatus(
            id=current.id,
            project_id=current.project_id,
            operation=current.operation,
            state=state if state is not None else current.state,
            progress=progress if progress is not None else current.progress,
            message=message if message is not None else current.message,
            created_at=current.created_at,
            updated_at=datetime.now(UTC),
            error=error if error is not None else current.error,
        )
