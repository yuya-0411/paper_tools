"""Safe, bounded Typst CLI execution with last-known-good PDF preservation."""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TypeVar

from paper_tools.schemas import CompileResult, CompileStatus

Runner = Callable[..., subprocess.CompletedProcess[str]]
T = TypeVar("T")

_PROCESS_COMPILE_LIMIT = 1
_PROCESS_COMPILE_SEMAPHORE = threading.BoundedSemaphore(_PROCESS_COMPILE_LIMIT)
_CANCELLATION_POLL_SECONDS = 0.05
_MAX_ERROR_LINE_BYTES = 2_000
_MAX_ERROR_TOTAL_BYTES = 20_000


def _creation_flags() -> int:
    """Prevent the bundled Typst process from flashing a console on Windows."""

    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class CompileCancelledError(Exception):
    """Raised in the compiler thread after a requested cancellation is complete."""


class CompileCancellation:
    """Coordinate cancellation with the subprocess and successful PDF publication."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._sealed = False
        self._process: subprocess.Popen[str] | None = None

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def cancel(self) -> bool:
        """Request cancellation, returning false once successful output is sealed."""

        with self._lock:
            if self._sealed:
                return False
            self._cancelled = True
            process = self._process
        if process is not None and process.poll() is None:
            with contextlib.suppress(OSError):
                process.terminate()
        return True

    def attach_process(self, process: subprocess.Popen[str]) -> bool:
        with self._lock:
            if self._cancelled:
                return False
            self._process = process
            return True

    def detach_process(self, process: subprocess.Popen[str]) -> None:
        with self._lock:
            if self._process is process:
                self._process = None

    def seal_success(self) -> bool:
        """Atomically make a successful PDF publication no longer cancellable."""

        with self._lock:
            if self._cancelled:
                return False
            self._sealed = True
            return True

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise CompileCancelledError("Typstコンパイルを取り消しました．")


async def run_cancellable_compile(
    operation: Callable[[], T],
    cancellation: CompileCancellation,
) -> T:
    """Run a synchronous compile transaction and join it fully on cancellation."""

    task = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        cancellation_accepted = cancellation.cancel()
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                cancellation.cancel()
            except Exception:
                break
        if cancellation_accepted:
            with contextlib.suppress(Exception):
                task.result()
            raise
        return task.result()


class TypstCompileService:
    def __init__(
        self,
        typst_executable: str | Path | None = None,
        *,
        timeout: float = 60.0,
        concurrency_limit: int = 2,
        queue_timeout: float = 1.0,
        runner: Runner = subprocess.run,
    ) -> None:
        if timeout <= 0 or concurrency_limit <= 0 or queue_timeout < 0:
            raise ValueError("timeout and concurrency settings must be positive")
        self.typst_executable = str(typst_executable) if typst_executable else None
        self.timeout = timeout
        self.queue_timeout = queue_timeout
        # The limit is intentionally shared by every service instance in this
        # process.  Keep accepting the constructor argument for compatibility;
        # callers cannot accidentally widen the application-wide limit.
        self._semaphore = _PROCESS_COMPILE_SEMAPHORE
        self._runner = runner

    def find_executable(self) -> str | None:
        if self.typst_executable:
            candidate = Path(self.typst_executable)
            if candidate.is_file():
                return str(candidate.resolve())
            found = shutil.which(self.typst_executable)
            return found
        return shutil.which("typst")

    def is_available(self) -> bool:
        return self.find_executable() is not None

    def version(self) -> str | None:
        executable = self.find_executable()
        if executable is None:
            return None
        try:
            completed = self._runner(
                [executable, "--version"],
                cwd=str(Path(executable).parent),
                capture_output=True,
                text=True,
                timeout=min(self.timeout, 5.0),
                check=False,
                creationflags=_creation_flags(),
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return completed.stdout.strip() if completed.returncode == 0 else None

    def build_command(
        self,
        main_path: Path,
        output_path: Path,
        *,
        project_root: Path,
    ) -> list[str]:
        executable = self.find_executable()
        if executable is None:
            raise FileNotFoundError("Typst CLIが見つかりません")
        root, main, output = self._validated_paths(main_path, output_path, project_root)
        return [executable, "compile", "--root", str(root), str(main), str(output)]

    def compile(
        self,
        main_path: Path,
        output_path: Path,
        *,
        project_root: Path | None = None,
        cancellation: CompileCancellation | None = None,
    ) -> CompileResult:
        started = time.monotonic()
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        executable = self.find_executable()
        if executable is None:
            return CompileResult.unavailable(
                "Typst CLIが見つかりません．TypstをインストールするとPDFを生成できます．"
            )
        root_input = project_root or main_path.parent
        try:
            root, main, output = self._validated_paths(main_path, output_path, root_input)
        except ValueError as exc:
            return self._result(
                CompileStatus.FAILED,
                started,
                errors=[str(exc)],
            )
        if not main.is_file():
            return self._result(
                CompileStatus.FAILED,
                started,
                errors=[f"Typstソースが見つかりません: {main.name}"],
            )
        if not self._acquire_compile_slot(cancellation):
            return self._result(
                CompileStatus.BUSY,
                started,
                errors=["他のPDF生成が実行中です．しばらく待って再実行してください．"],
            )
        temporary = output.parent / f".paper-tools-{uuid.uuid4().hex}.pdf"
        command = [executable, "compile", "--root", str(root), str(main), str(temporary)]
        try:
            output.parent.mkdir(parents=True, exist_ok=True)
            try:
                completed = self._execute_command(command, root, cancellation)
            except subprocess.TimeoutExpired as exc:
                self._remove_temporary(temporary)
                stdout = self._coerce_output(exc.stdout)
                stderr = self._coerce_output(exc.stderr)
                return self._result(
                    CompileStatus.TIMEOUT,
                    started,
                    command=command,
                    stdout=stdout,
                    stderr=stderr,
                    errors=[f"Typstコンパイルが{self.timeout:g}秒でタイムアウトしました．"],
                )
            except OSError as exc:
                self._remove_temporary(temporary)
                return self._result(
                    CompileStatus.FAILED,
                    started,
                    command=command,
                    errors=[f"Typstを起動できませんでした: {exc}"],
                )
            if completed.returncode != 0:
                self._remove_temporary(temporary)
                return self._result(
                    CompileStatus.FAILED,
                    started,
                    command=command,
                    exit_code=completed.returncode,
                    stdout=completed.stdout,
                    stderr=completed.stderr,
                    errors=self._extract_errors(completed.stderr),
                )
            if not self._valid_pdf(temporary):
                self._remove_temporary(temporary)
                return self._result(
                    CompileStatus.FAILED,
                    started,
                    command=command,
                    exit_code=completed.returncode,
                    stdout=completed.stdout,
                    stderr=completed.stderr,
                    errors=["Typstは成功を返しましたが，有効なPDFが生成されませんでした．"],
                )
            if cancellation is not None and not cancellation.seal_success():
                raise CompileCancelledError("Typstコンパイルを取り消しました．")
            os.replace(temporary, output)
            return self._result(
                CompileStatus.SUCCESS,
                started,
                command=command,
                exit_code=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
                output_path=str(output),
            )
        finally:
            self._remove_temporary(temporary)
            self._semaphore.release()

    async def compile_async(
        self,
        main_path: Path,
        output_path: Path,
        *,
        project_root: Path | None = None,
    ) -> CompileResult:
        cancellation = CompileCancellation()
        return await run_cancellable_compile(
            lambda: self.compile(
                main_path,
                output_path,
                project_root=project_root,
                cancellation=cancellation,
            ),
            cancellation,
        )

    def _acquire_compile_slot(self, cancellation: CompileCancellation | None) -> bool:
        deadline = time.monotonic() + self.queue_timeout
        while True:
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            remaining = deadline - time.monotonic()
            wait = max(0.0, min(_CANCELLATION_POLL_SECONDS, remaining))
            if self._semaphore.acquire(timeout=wait):
                return True
            if remaining <= 0:
                return False

    def _execute_command(
        self,
        command: list[str],
        root: Path,
        cancellation: CompileCancellation | None,
    ) -> subprocess.CompletedProcess[str]:
        # Injected runners keep unit tests and embedders backwards compatible.
        # Production execution uses Popen so cancellation can terminate Typst.
        if self._runner is not subprocess.run:
            completed = self._runner(
                command,
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
                creationflags=_creation_flags(),
            )
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            return completed

        process = subprocess.Popen(
            command,
            cwd=str(root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_creation_flags(),
        )
        if cancellation is not None and not cancellation.attach_process(process):
            self._stop_process(process)
            raise CompileCancelledError("Typstコンパイルを取り消しました．")
        deadline = time.monotonic() + self.timeout
        try:
            while True:
                if cancellation is not None and cancellation.cancelled:
                    self._stop_process(process)
                    raise CompileCancelledError("Typstコンパイルを取り消しました．")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._stop_process(process)
                    stdout, stderr = process.communicate()
                    raise subprocess.TimeoutExpired(
                        command,
                        self.timeout,
                        output=stdout,
                        stderr=stderr,
                    )
                try:
                    stdout, stderr = process.communicate(
                        timeout=min(_CANCELLATION_POLL_SECONDS, remaining)
                    )
                except subprocess.TimeoutExpired:
                    continue
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                return subprocess.CompletedProcess(
                    command,
                    process.returncode,
                    stdout,
                    stderr,
                )
        finally:
            if cancellation is not None:
                cancellation.detach_process(process)

    @staticmethod
    def _stop_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        with contextlib.suppress(OSError):
            process.terminate()
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                process.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=0.25)

    @staticmethod
    def _validated_paths(
        main_path: Path,
        output_path: Path,
        project_root: Path,
    ) -> tuple[Path, Path, Path]:
        root = project_root.resolve()
        main = main_path.resolve()
        output = output_path.resolve()
        if main == root or root not in main.parents:
            raise ValueError("Typstソースはプロジェクト内に配置してください")
        if output == root or root not in output.parents:
            raise ValueError("PDF出力先はプロジェクト内に配置してください")
        if output.suffix.lower() != ".pdf":
            raise ValueError("PDF出力先の拡張子は.pdfである必要があります")
        return root, main, output

    @staticmethod
    def _valid_pdf(path: Path) -> bool:
        try:
            with path.open("rb") as stream:
                return stream.read(5) == b"%PDF-" and path.stat().st_size >= 8
        except OSError:
            return False

    @staticmethod
    def _remove_temporary(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # The unique temporary file cannot replace the last-known-good PDF.
            return

    @staticmethod
    def _extract_errors(stderr: str) -> list[str]:
        lines = [line.strip() for line in stderr.splitlines() if line.strip()]
        useful = [
            line
            for line in lines
            if "error" in line.lower() or "warning" in line.lower() or ".typ" in line.lower()
        ]
        selected = (
            useful or lines or ["Typstコンパイルに失敗しました．詳細はログを確認してください．"]
        )
        errors: list[str] = []
        remaining = _MAX_ERROR_TOTAL_BYTES
        for line in selected[:20]:
            if remaining <= 0:
                break
            clipped = TypstCompileService._truncate_utf8(
                line,
                min(_MAX_ERROR_LINE_BYTES, remaining),
            )
            errors.append(clipped)
            remaining -= len(clipped.encode("utf-8"))
        return errors

    @staticmethod
    def _truncate_utf8(value: str, maximum_bytes: int) -> str:
        encoded = value.encode("utf-8")
        if len(encoded) <= maximum_bytes:
            return value
        if maximum_bytes <= 3:
            return encoded[:maximum_bytes].decode("utf-8", errors="ignore")
        return encoded[: maximum_bytes - 3].decode("utf-8", errors="ignore") + "…"

    @staticmethod
    def _coerce_output(value: str | bytes | None) -> str:
        if value is None:
            return ""
        return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value

    @staticmethod
    def _result(
        status: CompileStatus,
        started: float,
        *,
        command: Sequence[str] = (),
        exit_code: int | None = None,
        stdout: str = "",
        stderr: str = "",
        errors: Sequence[str] = (),
        output_path: str | None = None,
    ) -> CompileResult:
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        return CompileResult(
            status=status,
            success=status is CompileStatus.SUCCESS,
            command=list(command),
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            errors=list(errors),
            output_path=output_path,
            duration_ms=duration_ms,
        )
