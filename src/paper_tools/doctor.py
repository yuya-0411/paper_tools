"""Runtime diagnostics shared by the CLI and documentation examples."""

from __future__ import annotations

import asyncio
import platform
import sqlite3
import sys
import tempfile
from dataclasses import asdict, dataclass

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.providers import OllamaProvider, OllamaProviderConfig
from paper_tools.services.templates import TemplateService
from paper_tools.services.typst_compiler import TypstCompileService


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    name: str
    status: str
    detail: str
    required: bool = True

    def model_dump(self) -> dict[str, object]:
        return asdict(self)


def run_doctor(settings: AppSettings) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    python_ok = sys.version_info >= (3, 11)
    checks.append(
        DoctorCheck(
            "Python",
            "ok" if python_ok else "error",
            platform.python_version(),
        )
    )
    checks.append(DoctorCheck("SQLite", "ok", sqlite3.sqlite_version))
    checks.extend(_storage_checks(settings))
    compiler = TypstCompileService(settings.typst_executable, timeout=5)
    executable = compiler.find_executable()
    checks.append(
        DoctorCheck(
            "Typst CLI",
            "ok" if executable else "unavailable",
            compiler.version() or "未インストール（PDF以外は利用可能）",
            required=False,
        )
    )
    try:
        manifests = TemplateService().list_templates()
        checks.append(DoctorCheck("テンプレート", "ok", f"{len(manifests)}件"))
    except Exception as exc:
        checks.append(DoctorCheck("テンプレート", "error", str(exc)))
    try:
        database = Database(settings)
        database.initialize()
        checks.append(
            DoctorCheck(
                "データベース",
                "ok" if database.ping() else "error",
                "接続成功" if database.ping() else "接続失敗",
            )
        )
        database.dispose()
    except Exception as exc:
        checks.append(DoctorCheck("データベース", "error", str(exc)))
    checks.append(_ollama_check(settings))
    checks.append(
        DoctorCheck(
            "設定",
            "ok",
            f"provider={settings.generation_provider}, host={settings.host}:{settings.port}",
        )
    )
    return checks


def _storage_checks(settings: AppSettings) -> list[DoctorCheck]:
    try:
        settings.ensure_directories()
        with tempfile.NamedTemporaryFile(dir=settings.data_dir, delete=True) as stream:
            stream.write(b"ok")
            stream.flush()
        return [
            DoctorCheck("データディレクトリ", "ok", str(settings.data_dir)),
            DoctorCheck("書込み権限", "ok", "書込み可能"),
        ]
    except OSError as exc:
        return [
            DoctorCheck("データディレクトリ", "error", str(settings.data_dir)),
            DoctorCheck("書込み権限", "error", str(exc)),
        ]


def _ollama_check(settings: AppSettings) -> DoctorCheck:
    provider = OllamaProvider(
        OllamaProviderConfig(
            base_url=settings.ollama_url,
            model=settings.ollama_model or "未設定",
            timeout=min(settings.generation_timeout_seconds, 2.0),
            temperature=settings.generation_temperature,
        )
    )
    try:
        health = asyncio.run(provider.healthcheck())
    except (OSError, RuntimeError) as exc:
        return DoctorCheck("Ollama", "unavailable", str(exc), required=False)
    return DoctorCheck(
        "Ollama",
        "ok" if health.available else "unavailable",
        health.message,
        required=False,
    )


def doctor_exit_code(checks: list[DoctorCheck]) -> int:
    return 0 if all(item.status != "error" or not item.required for item in checks) else 2


__all__ = ["DoctorCheck", "doctor_exit_code", "run_doctor"]
