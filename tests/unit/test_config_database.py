from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.models import ApplicationSetting, Author


def test_settings_derive_local_paths_and_create_directories(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "state", _env_file=None)

    assert settings.host == "127.0.0.1"
    assert (
        settings.database_url
        == f"sqlite+pysqlite:///{(tmp_path / 'state/paper_tools.sqlite3').as_posix()}"
    )
    assert settings.projects_dir == (tmp_path / "state" / "projects").resolve()
    assert settings.openai_api_key is None

    settings.ensure_directories()
    assert settings.projects_dir.is_dir()
    assert settings.exports_dir.is_dir()


def test_settings_load_environment_and_normalize_extensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PAPER_TOOLS_DATA_DIR", str(tmp_path / "custom"))
    monkeypatch.setenv("PAPER_TOOLS_UPLOAD_MAX_BYTES", "1234")
    monkeypatch.setenv("PAPER_TOOLS_ALLOWED_UPLOAD_EXTENSIONS", '["PNG", ".CSV"]')
    monkeypatch.setenv("PAPER_TOOLS_OPENAI_API_KEY", "environment-only-secret")

    settings = AppSettings(_env_file=None)

    assert settings.data_dir == (tmp_path / "custom").resolve()
    assert settings.upload_max_bytes == 1234
    assert settings.allowed_upload_extensions == frozenset({".png", ".csv"})
    assert settings.openai_api_key is not None
    assert settings.openai_api_key.get_secret_value() == "environment-only-secret"
    assert "environment-only-secret" not in repr(settings)


def test_settings_reject_non_sqlite_database(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="SQLite"):
        AppSettings(
            data_dir=tmp_path,
            database_url="postgresql://localhost/papers",
            _env_file=None,
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("ollama_url", "ftp://127.0.0.1/models"),
        ("ollama_url", "http://user:secret@127.0.0.1:11434"),
        ("openai_compatible_base_url", "https://provider.invalid/v1?token=secret"),
        ("openai_compatible_base_url", "http://provider.invalid/v1"),
    ],
)
def test_settings_reject_unsafe_provider_urls(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    with pytest.raises(ValueError, match=r"URL|HTTPS"):
        AppSettings(data_dir=tmp_path, _env_file=None, **{field: value})


def test_database_initialization_is_idempotent_and_enables_foreign_keys(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path, _env_file=None)
    database = Database(settings)
    database.initialize()
    database.initialize()

    tables = set(inspect(database.engine).get_table_names())
    assert {
        "projects",
        "authors",
        "paper_specs",
        "sections",
        "section_versions",
        "templates",
        "project_assets",
        "references",
        "generation_runs",
        "generation_instructions",
        "paper_advice",
        "compile_results",
        "application_settings",
    } <= tables
    assert database.ping()

    with pytest.raises(IntegrityError), database.session() as session:
        session.add(Author(project_id="missing", name="No Project", position=0))

    database.dispose()


def test_database_session_rolls_back_on_exception() -> None:
    database = Database(database_url="sqlite+pysqlite:///:memory:")
    database.initialize()

    with pytest.raises(RuntimeError, match="stop"), database.session() as session:
        session.add(ApplicationSetting(key="theme", value={"name": "light"}))
        session.flush()
        raise RuntimeError("stop")

    with database.session() as session:
        count = session.scalar(text("SELECT COUNT(*) FROM application_settings"))
        assert count == 0
    database.dispose()


def test_application_settings_refuse_secrets() -> None:
    with pytest.raises(ValueError, match="environment variables"):
        ApplicationSetting(key="openai_api_key", value={"value": "secret"})


@pytest.mark.parametrize(
    "value",
    [
        {"providers": {"api-key": "must-not-be-stored"}},
        {"profiles": [{"access_token": "must-not-be-stored"}]},
    ],
)
def test_application_settings_refuse_nested_secret_keys(value: dict[str, object]) -> None:
    with pytest.raises(ValueError, match="environment variables"):
        ApplicationSetting(key="runtime", value=value)
