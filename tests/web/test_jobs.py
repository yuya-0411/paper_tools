from __future__ import annotations

import re
import sys
import time

from sqlalchemy import select

from paper_tools.models import CompileResult
from paper_tools.services.jobs import JobState
from paper_tools.services.projects import ProjectService
from tests.web._support import WebHarness


def test_generation_job_and_advice_resolution(web_app: WebHarness) -> None:
    project_id = web_app.create_project(
        name="Advice project",
        values={
            "objective": "",
            "method": "センサと制御器を用いる提案手法である．",
            "results": "有効であり改善した．",
            "experimental_conditions": "",
            "metrics": "",
            "limitations": "",
        },
    )
    editor = web_app.client.get(f"/projects/{project_id}")
    assert editor.status_code == 200
    assert "研究目的を明確にしてください" in editor.text
    assert "実験条件が不足しています" in editor.text
    assert "定量的な裏付けが必要です" in editor.text

    advice_match = re.search(
        rf"/projects/{project_id}/advice/([0-9a-f-]+)/resolve",
        editor.text,
    )
    assert advice_match is not None
    resolved = web_app.client.post(
        advice_match.group(0),
        data={"csrf_token": web_app.csrf_token()},
    )
    assert resolved.status_code == 200
    assert "解決済み" in resolved.text

    job_id = web_app.submit_job(f"/projects/{project_id}/generate")
    terminal = web_app.wait_for_job(job_id)
    assert "完了" in terminal
    assert "100%" in terminal
    terminal_response = web_app.client.get(f"/jobs/{job_id}")
    assert terminal_response.headers["hx-refresh"] == "true"


def test_typst_unavailable_is_visible_and_compile_job_fails_cleanly(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="No Typst")
    editor = web_app.client.get(f"/projects/{project_id}")
    assert editor.status_code == 200
    assert "Typst CLIをインストールするとPDFを生成できます" in editor.text
    assert re.search(r"<button[^>]+disabled[^>]*>PDFを更新</button>", editor.text)

    missing_pdf = web_app.client.get(f"/projects/{project_id}/pdf")
    assert missing_pdf.status_code == 404
    assert "PDFはまだ生成されていません" in missing_pdf.text

    job_id = web_app.submit_job(f"/projects/{project_id}/compile")
    terminal = web_app.wait_for_job(job_id)
    assert "失敗" in terminal
    assert "Typst CLIが見つかりません" in terminal

    unknown = web_app.client.get("/jobs/does-not-exist")
    assert unknown.status_code == 404
    assert "処理状態が見つかりません" in unknown.text


def test_successful_compile_job_exposes_pdf_download(web_app: WebHarness) -> None:
    web_app.settings.typst_executable = sys.executable
    with web_app.database.session() as session:
        project = ProjectService(session).create_project(name="PDF route regression")
        project.typst_source = "= PDF route regression\n"
        project_id = project.id

    project_dir = web_app.settings.projects_dir / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "compile").write_text(
        "\n".join(
            [
                "import sys",
                "from pathlib import Path",
                "Path(sys.argv[-1]).write_bytes(b'%PDF-1.7\\nroute-regression')",
            ]
        ),
        encoding="utf-8",
    )

    job_id = web_app.submit_job(f"/projects/{project_id}/compile")
    assert "完了" in web_app.wait_for_job(job_id)
    pdf = web_app.client.get(f"/projects/{project_id}/pdf")

    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert "PDF%20route%20regression.pdf" in pdf.headers["content-disposition"]
    assert pdf.content == b"%PDF-1.7\nroute-regression"


def test_cancelled_compile_stops_process_without_committing_pdf(web_app: WebHarness) -> None:
    web_app.settings.typst_executable = sys.executable
    web_app.settings.compile_timeout_seconds = 60
    with web_app.database.session() as session:
        project = ProjectService(session).create_project(name="Cancelled compile")
        project.typst_source = "= Cancelled compile\n"
        project_id = project.id

    project_dir = web_app.settings.projects_dir / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    started = project_dir / "started"
    completed = project_dir / "completed"
    (project_dir / "compile").write_text(
        "\n".join(
            [
                "import os",
                "import sys",
                "import time",
                "from pathlib import Path",
                "Path('started').write_text(str(os.getpid()), encoding='utf-8')",
                "time.sleep(30)",
                "Path(sys.argv[-1]).write_bytes(b'%PDF-1.7\\n')",
                "Path('completed').write_text('yes', encoding='utf-8')",
            ]
        ),
        encoding="utf-8",
    )

    job_id = web_app.submit_job(f"/projects/{project_id}/compile")
    for _ in range(200):
        if started.exists():
            break
        time.sleep(0.01)
    assert started.exists()

    cancelled = web_app.client.post(
        f"/jobs/{job_id}/cancel",
        data={"csrf_token": web_app.csrf_token()},
    )

    assert cancelled.status_code == 200
    assert web_app.app.state.jobs.get(job_id).state is JobState.CANCELLED
    assert not completed.exists()
    assert not (project_dir / "output" / "paper.pdf").exists()
    assert not list(project_dir.glob(".paper-tools-*.pdf"))
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id, aggregate=False)
        stored = session.scalars(
            select(CompileResult).where(CompileResult.project_id == project_id)
        ).all()
        assert project.pdf_relative_path is None
        assert stored == []
