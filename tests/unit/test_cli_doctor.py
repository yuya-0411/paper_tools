from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import inspect
from typer.testing import CliRunner

from paper_tools import __version__, cli
from paper_tools.config import AppSettings
from paper_tools.doctor import DoctorCheck, doctor_exit_code, run_doctor

runner = CliRunner()


def _settings(tmp_path: Path, **values: Any) -> AppSettings:
    defaults: dict[str, Any] = {
        "data_dir": tmp_path / "state",
        "database_url": (
            f"sqlite+pysqlite:///{(tmp_path / 'state/paper_tools.sqlite3').as_posix()}"
        ),
        "host": "127.0.0.1",
        "port": 8000,
        "typst_executable": "paper-tools-test-typst-does-not-exist",
        "ollama_model": "",
        "_env_file": None,
    }
    defaults.update(values)
    return AppSettings(**defaults)


def test_cli_help_version_and_template_formats() -> None:
    help_result = runner.invoke(cli.app, ["--help"])
    assert help_result.exit_code == 0
    for command in ("serve", "launch", "doctor", "init-db", "templates", "compile", "export"):
        assert command in help_result.output

    version = runner.invoke(cli.app, ["--version"])
    assert version.exit_code == 0
    assert f"paper-tools {__version__}" in version.output

    template_json = runner.invoke(cli.app, ["templates", "--format", "json"])
    assert template_json.exit_code == 0
    manifests = json.loads(template_json.stdout)
    assert len(manifests) == 8
    assert {item["id"] for item in manifests} == {
        "generic-ja",
        "generic-en",
        "engineering-two-column",
        "robotics-experiment",
        "short-paper",
        "literature-review",
        "research-proposal",
        "experiment-report",
    }

    template_console = runner.invoke(cli.app, ["templates"])
    assert template_console.exit_code == 0
    assert "標準テンプレート" in template_console.output
    assert "generic-ja" in template_console.output

    invalid = runner.invoke(cli.app, ["templates", "--format", "xml"])
    assert invalid.exit_code == 2
    assert "console または json" in invalid.output


def test_cli_init_db_creates_schema_in_temp_data_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    monkeypatch.setattr(cli, "get_settings", lambda: settings)

    result = runner.invoke(cli.app, ["init-db"])

    assert result.exit_code == 0
    assert "データベースを初期化しました" in result.output
    database_path = settings.data_dir / "paper_tools.sqlite3"
    assert database_path.is_file()

    from paper_tools.database import Database

    database = Database(settings)
    try:
        assert "projects" in inspect(database.engine).get_table_names()
        assert "paper_advice" in inspect(database.engine).get_table_names()
    finally:
        database.dispose()


def test_cli_doctor_json_console_and_required_exit_semantics(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    healthy = [
        DoctorCheck("Python", "ok", "3.12"),
        DoctorCheck("Typst CLI", "unavailable", "not installed", required=False),
    ]
    monkeypatch.setattr(cli, "run_doctor", lambda _settings: healthy)

    result = runner.invoke(cli.app, ["doctor", "--format", "json"])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload == [item.model_dump() for item in healthy]
    assert payload[1]["required"] is False

    console_result = runner.invoke(cli.app, ["doctor"])
    assert console_result.exit_code == 0
    assert "paper_tools 環境診断" in console_result.output
    assert "[N/A]" in console_result.output

    required_failure = [DoctorCheck("データベース", "error", "接続失敗")]
    monkeypatch.setattr(cli, "run_doctor", lambda _settings: required_failure)
    failure = runner.invoke(cli.app, ["doctor", "--format", "json"])
    assert failure.exit_code == 2
    assert json.loads(failure.stdout)[0]["status"] == "error"

    invalid = runner.invoke(cli.app, ["doctor", "--format", "yaml"])
    assert invalid.exit_code == 2
    assert "console または json" in invalid.output


def test_cli_serve_forwards_local_options_without_starting_a_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path, debug=True)
    calls: list[dict[str, Any]] = []
    cache_resets: list[bool] = []
    monkeypatch.setenv("PAPER_TOOLS_HOST", "127.0.0.1")
    monkeypatch.setenv("PAPER_TOOLS_PORT", "8000")
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "reset_settings_cache", lambda: cache_resets.append(True))
    monkeypatch.setattr(
        "paper_tools.cli.uvicorn.run",
        lambda *args, **kwargs: calls.append({"args": args, **kwargs}),
    )

    result = runner.invoke(
        cli.app,
        ["serve", "--host", "127.0.0.1", "--port", "8765", "--reload"],
    )

    assert result.exit_code == 0
    assert "http://127.0.0.1:8765" in result.output
    assert cache_resets == [True]
    assert calls == [
        {
            "args": ("paper_tools.app:create_app",),
            "factory": True,
            "host": "127.0.0.1",
            "port": 8765,
            "reload": True,
            "log_level": "debug",
        }
    ]
    assert os.environ["PAPER_TOOLS_HOST"] == "127.0.0.1"
    assert os.environ["PAPER_TOOLS_PORT"] == "8765"


def test_cli_serve_uses_validated_environment_defaults(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    settings.host = "localhost"
    settings.port = 8123
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(
        "paper_tools.cli.uvicorn.run",
        lambda *args, **kwargs: calls.append({"args": args, **kwargs}),
    )

    result = runner.invoke(cli.app, ["serve"])

    assert result.exit_code == 0
    assert "http://localhost:8123" in result.output
    assert calls[0]["host"] == "localhost"
    assert calls[0]["port"] == 8123


def test_cli_launch_starts_server_and_schedules_browser(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    scheduled: list[str] = []
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "is_paper_tools_ready", lambda _url: False)
    monkeypatch.setattr(cli, "schedule_browser_open", lambda url: scheduled.append(url))
    monkeypatch.setattr(
        "paper_tools.cli.uvicorn.run",
        lambda *args, **kwargs: calls.append({"args": args, **kwargs}),
    )

    result = runner.invoke(cli.app, ["launch", "--host", "127.0.0.1", "--port", "8765"])

    assert result.exit_code == 0
    assert "ブラウザを自動で開きます" in result.output
    assert "このウィンドウを閉じると" in result.output
    assert scheduled == ["http://127.0.0.1:8765/"]
    assert calls[0]["host"] == "127.0.0.1"
    assert calls[0]["port"] == 8765
    assert calls[0]["reload"] is False


def test_cli_launch_reuses_running_app_without_new_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    opened: list[str] = []
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "is_paper_tools_ready", lambda _url: True)
    monkeypatch.setattr(cli, "open_in_default_browser", lambda url: opened.append(url))
    monkeypatch.setattr(
        "paper_tools.cli.uvicorn.run",
        lambda *_args, **_kwargs: pytest.fail("a second server must not be started"),
    )

    result = runner.invoke(cli.app, ["launch"])

    assert result.exit_code == 0
    assert "既に起動しています" in result.output
    assert opened == ["http://127.0.0.1:8000/"]


def test_cli_launch_no_browser_does_not_schedule_or_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "is_paper_tools_ready", lambda _url: False)
    monkeypatch.setattr(
        cli,
        "schedule_browser_open",
        lambda _url: pytest.fail("browser scheduling must be disabled"),
    )
    monkeypatch.setattr("paper_tools.cli.uvicorn.run", lambda *_args, **_kwargs: None)

    result = runner.invoke(cli.app, ["launch", "--no-browser"])

    assert result.exit_code == 0
    assert "ブラウザを自動で開きます" not in result.output


def test_run_doctor_core_checks_use_local_fakes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)

    class MissingTypst:
        def __init__(self, _executable: str, *, timeout: float) -> None:
            assert timeout == 5

        def find_executable(self) -> None:
            return None

        def version(self) -> None:
            return None

    monkeypatch.setattr("paper_tools.doctor.TypstCompileService", MissingTypst)
    monkeypatch.setattr(
        "paper_tools.doctor._ollama_check",
        lambda _settings: DoctorCheck("Ollama", "unavailable", "offline", required=False),
    )

    checks = run_doctor(settings)
    by_name = {item.name: item for item in checks}

    assert by_name["Python"].status == "ok"
    assert by_name["SQLite"].status == "ok"
    assert by_name["データディレクトリ"].status == "ok"
    assert by_name["書込み権限"].status == "ok"
    assert by_name["Typst CLI"] == DoctorCheck(
        "Typst CLI",
        "unavailable",
        "未インストール（PDF以外は利用可能）",
        required=False,
    )
    assert by_name["テンプレート"].detail == "8件"
    assert by_name["データベース"].detail == "接続成功"
    assert by_name["Ollama"].required is False
    assert by_name["設定"].detail == "provider=rule-based, host=127.0.0.1:8000"
    assert doctor_exit_code(checks) == 0


def test_run_doctor_reports_storage_template_and_database_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)

    def fail_storage(_settings: AppSettings) -> None:
        raise OSError("read-only test directory")

    class AvailableTypst:
        def __init__(self, _executable: str, *, timeout: float) -> None:
            assert timeout == 5

        def find_executable(self) -> str:
            return "C:/fake/typst.exe"

        def version(self) -> str:
            return "typst 0.test"

    class BrokenTemplates:
        def list_templates(self) -> list[object]:
            raise RuntimeError("template registry failed")

    class BrokenDatabase:
        def __init__(self, _settings: AppSettings) -> None:
            raise RuntimeError("database failed")

    monkeypatch.setattr(AppSettings, "ensure_directories", fail_storage)
    monkeypatch.setattr("paper_tools.doctor.TypstCompileService", AvailableTypst)
    monkeypatch.setattr("paper_tools.doctor.TemplateService", BrokenTemplates)
    monkeypatch.setattr("paper_tools.doctor.Database", BrokenDatabase)
    monkeypatch.setattr(
        "paper_tools.doctor._ollama_check",
        lambda _settings: DoctorCheck("Ollama", "unavailable", "offline", required=False),
    )

    checks = run_doctor(settings)
    by_name = {item.name: item for item in checks}

    assert by_name["データディレクトリ"].status == "error"
    assert by_name["書込み権限"].detail == "read-only test directory"
    assert by_name["Typst CLI"].detail == "typst 0.test"
    assert by_name["テンプレート"].detail == "template registry failed"
    assert by_name["データベース"].detail == "database failed"
    assert doctor_exit_code(checks) == 2
    assert doctor_exit_code([DoctorCheck("optional", "error", "x", required=False)]) == 0


def test_ollama_doctor_check_uses_mocked_healthcheck(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from paper_tools import doctor

    settings = _settings(tmp_path, ollama_model="test-model")

    class HealthyProvider:
        def __init__(self, config: Any) -> None:
            assert config.model == "test-model"
            assert config.timeout == 2.0

        async def healthcheck(self) -> SimpleNamespace:
            return SimpleNamespace(available=True, message="mock ready")

    monkeypatch.setattr(doctor, "OllamaProvider", HealthyProvider)
    healthy = doctor._ollama_check(settings)
    assert healthy == DoctorCheck("Ollama", "ok", "mock ready", required=False)

    class OfflineProvider:
        def __init__(self, _config: Any) -> None:
            pass

        async def healthcheck(self) -> None:
            raise OSError("mock offline")

    monkeypatch.setattr(doctor, "OllamaProvider", OfflineProvider)
    offline = doctor._ollama_check(settings)
    assert offline == DoctorCheck("Ollama", "unavailable", "mock offline", required=False)
