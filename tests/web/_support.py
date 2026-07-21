from __future__ import annotations

import re
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from starlette.testclient import TestClient

from paper_tools.app import create_app
from paper_tools.config import AppSettings
from paper_tools.database import Database

_CSRF_RE = re.compile(r'name="csrf_token" value="([^"]+)"')
_PROJECT_LOCATION_RE = re.compile(r"^/projects/([0-9a-f-]+)(?:\?created=1)?$")
_JOB_RE = re.compile(r"/jobs/([0-9a-f]+)")


@dataclass(slots=True)
class WebHarness:
    app: FastAPI
    client: TestClient
    settings: AppSettings
    database: Database

    def csrf_token(self) -> str:
        response = self.client.get("/projects/new")
        assert response.status_code == 200
        match = _CSRF_RE.search(response.text)
        assert match is not None
        token = match.group(1)
        assert self.client.cookies.get("paper_tools_csrf") == token
        return token

    def create_project(
        self,
        *,
        name: str = "Web project",
        title: str = "Web paper",
        language: str = "ja",
        template_id: str | None = None,
        values: Mapping[str, Any] | None = None,
    ) -> str:
        form: dict[str, Any] = {
            "csrf_token": self.csrf_token(),
            "name": name,
            "title": title,
            "language": language,
            "paper_type": "research-paper",
            "research_field": "Robotics" if language == "en" else "ロボティクス",
            "template_id": template_id or ("generic-en" if language == "en" else "generic-ja"),
            "objective": (
                "Evaluate a supplied synthetic benchmark."
                if language == "en"
                else "入力済みの合成データを用いて制御手法を評価する．"
            ),
            "method": (
                "A bounded controller uses the supplied measurements."
                if language == "en"
                else "入力済みの測定値を用いる制御手法である．"
            ),
            "author_name": "Test Author" if language == "en" else "試験 著者",
            "author_affiliation": "Test Laboratory",
            "author_email": "author@example.invalid",
            "author_orcid": "",
            "author_corresponding": "0",
            "provider": "rule-based",
        }
        if values:
            form.update(values)
        response = self.client.post("/projects", data=form, follow_redirects=False)
        assert response.status_code == 303, response.text
        location = response.headers["location"]
        match = _PROJECT_LOCATION_RE.fullmatch(location)
        assert match is not None
        return match.group(1)

    def submit_job(self, path: str, *, data: Mapping[str, Any] | None = None) -> str:
        payload: dict[str, Any] = {"csrf_token": self.csrf_token()}
        if data:
            payload.update(data)
        response = self.client.post(path, data=payload)
        assert response.status_code == 200, response.text
        match = _JOB_RE.search(response.text)
        assert match is not None
        return match.group(1)

    def wait_for_job(self, job_id: str, *, attempts: int = 500) -> str:
        for _ in range(attempts):
            response = self.client.get(f"/jobs/{job_id}")
            assert response.status_code == 200
            if "hx-get=" not in response.text:
                return response.text
            time.sleep(0.01)
        raise AssertionError(f"job {job_id} did not reach a terminal state")


@contextmanager
def open_web_harness(
    tmp_path: Path,
    *,
    upload_max_bytes: int = 1024,
) -> Iterator[WebHarness]:
    settings = AppSettings(
        data_dir=tmp_path / "data",
        database_url="sqlite+pysqlite:///:memory:",
        typst_executable="paper-tools-test-typst-does-not-exist",
        upload_max_bytes=upload_max_bytes,
        generation_timeout_seconds=5,
        compile_timeout_seconds=2,
    )
    database = Database(settings)
    app = create_app(settings, database=database)
    with TestClient(app, base_url="http://testserver") as client:
        yield WebHarness(app=app, client=client, settings=settings, database=database)
