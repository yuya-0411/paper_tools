from __future__ import annotations

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from paper_tools.app import create_app
from paper_tools.config import RUNTIME_SETTING_FIELDS, AppSettings
from paper_tools.database import Database
from paper_tools.models import ApplicationSetting, GenerationRun
from paper_tools.services.projects import ProjectService
from tests.web._support import WebHarness


def test_home_templates_settings_and_security_headers(web_app: WebHarness) -> None:
    home = web_app.client.get("/")

    assert home.status_code == 200
    assert "研究情報を，検証可能な" in home.text
    assert "Typstがなくても原稿生成と編集は利用できます" in home.text
    assert home.headers["x-content-type-options"] == "nosniff"
    assert home.headers["x-frame-options"] == "SAMEORIGIN"
    assert "default-src 'self'" in home.headers["content-security-policy"]
    assert "paper_tools_csrf" in home.cookies

    health = web_app.client.get("/healthz")
    assert health.status_code == 200
    assert health.json() == {"app": "paper_tools", "status": "ok", "version": "0.2.0"}

    templates = web_app.client.get("/templates")
    assert templates.status_code == 200
    assert templates.text.count("このテンプレートで作成") == 8
    for template_id in (
        "generic-ja",
        "generic-en",
        "engineering-two-column",
        "robotics-experiment",
        "short-paper",
        "literature-review",
        "research-proposal",
        "experiment-report",
    ):
        assert f"template={template_id}" in templates.text

    settings = web_app.client.get("/settings")
    assert settings.status_code == 200
    assert "rule-based" in settings.text
    assert "未検出" in settings.text
    assert "秘密情報は画面へ再表示せず" in settings.text
    assert 'name="upload_max_mb"' in settings.text
    assert settings.text.count('step="any"') >= 4
    assert settings.text.count(" required") >= 6

    stylesheet = web_app.client.get("/static/app.css")
    assert stylesheet.status_code == 200
    assert "text/css" in stylesheet.headers["content-type"]
    assert ".editor-aside { display: flex; grid-column: 2" in stylesheet.text

    wizard = web_app.client.get("/projects/new")
    assert wizard.status_code == 200
    assert "novalidate" in wizard.text
    assert '@submit="validateBeforeSubmit($event)"' in wizard.text
    assert wizard.text.count("data-wizard-step=") == 5


def test_csrf_is_required_and_invalid_page_target_is_a_user_error(web_app: WebHarness) -> None:
    missing = web_app.client.post(
        "/projects",
        data={"name": "Missing token", "language": "ja", "template_id": "generic-ja"},
    )
    assert missing.status_code == 403

    wrong = web_app.client.post(
        "/projects",
        data={
            "csrf_token": "wrong-token",
            "name": "Wrong token",
            "language": "ja",
            "template_id": "generic-ja",
        },
    )
    assert wrong.status_code == 403

    invalid_number = web_app.client.post(
        "/projects",
        data={
            "csrf_token": web_app.csrf_token(),
            "name": "Invalid page target",
            "language": "ja",
            "template_id": "generic-ja",
            "page_target": "not-a-number",
        },
    )
    assert invalid_number.status_code == 400
    assert "ページ数" in invalid_number.text

    with web_app.database.session() as session:
        assert ProjectService(session).list_projects() == []


def test_settings_post_persists_runtime_values_without_secrets(web_app: WebHarness) -> None:
    secret = "must-never-enter-the-database"
    saved = web_app.client.post(
        "/settings",
        data={
            "csrf_token": web_app.csrf_token(),
            "typst_executable": "typst-custom",
            "compile_timeout_seconds": "45.5",
            "upload_max_mb": "0.25",
            "backup_count": "17",
            "generation_provider": "rule-based",
            "generation_timeout_seconds": "33",
            "generation_temperature": "0.7",
            "maximum_output_tokens": "2048",
            "ollama_url": "http://127.0.0.1:11435",
            "ollama_model": "",
            "openai_base_url": "https://example.invalid/v1",
            "openai_model": "local-regression-model",
            "japanese_punctuation": "、。",
            "english_variant": "british",
            "openai_api_key": secret,
        },
        follow_redirects=False,
    )

    assert saved.status_code == 303
    assert saved.headers["location"] == "/settings?saved=1"
    assert web_app.settings.typst_executable == "typst-custom"
    assert web_app.settings.upload_max_bytes == 256 * 1024
    assert web_app.settings.backup_count == 17
    assert web_app.settings.english_variant == "british"
    with web_app.database.session() as session:
        row = session.get(ApplicationSetting, "runtime")
        assert row is not None
        assert set(row.value) == set(RUNTIME_SETTING_FIELDS)
        assert row.value["typst_executable"] == "typst-custom"
        assert row.value["openai_compatible_model"] == "local-regression-model"
        serialized = repr(row.value)
        assert "openai_api_key" not in row.value
        assert secret not in serialized


def test_lifespan_quarantines_invalid_persisted_runtime_settings(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "invalid-runtime", _env_file=None)
    database = Database(settings)
    database.initialize()
    with database.session() as session:
        session.add(
            ApplicationSetting(
                key="runtime",
                value={"generation_provider": "not-a-provider"},
            )
        )

    app = create_app(settings, database=database)
    with TestClient(app, base_url="http://testserver") as client:
        assert client.get("/").status_code == 200
        assert settings.generation_provider == "rule-based"

    with database.session() as session:
        quarantined = session.get(ApplicationSetting, "runtime")
        assert quarantined is None or quarantined.value == {}
    database.dispose()


def test_environment_runtime_setting_takes_precedence_over_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PAPER_TOOLS_GENERATION_PROVIDER", "mock")
    settings = AppSettings(data_dir=tmp_path / "environment-priority", _env_file=None)
    assert "generation_provider" in settings.model_fields_set
    database = Database(settings)
    database.initialize()
    with database.session() as session:
        session.add(
            ApplicationSetting(
                key="runtime",
                value={"generation_provider": "rule-based", "backup_count": 23},
            )
        )

    app = create_app(settings, database=database)
    with TestClient(app, base_url="http://testserver") as client:
        assert client.get("/settings").status_code == 200
        assert settings.generation_provider == "mock"
        assert settings.backup_count == 23
    database.dispose()


def test_lifespan_marks_interrupted_run_and_project_failed(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "interrupted", _env_file=None)
    database = Database(settings)
    database.initialize()
    with database.session() as session:
        project = ProjectService(session).create_project(name="Interrupted")
        project.status = "generating"
        project_id = project.id
        session.add(
            GenerationRun(
                project_id=project.id,
                operation="generate",
                provider="mock",
                status="generating",
            )
        )

    app = create_app(settings, database=database)
    with TestClient(app, base_url="http://testserver") as client:
        assert client.get("/").status_code == 200

    with database.session() as session:
        recovered = ProjectService(session).get_project(project_id)
        assert recovered.status == "failed"
        assert recovered.generation_runs[0].status == "failed"
        assert "再起動" in recovered.generation_runs[0].message
    database.dispose()
