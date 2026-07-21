from __future__ import annotations

import io
import zipfile
from collections.abc import Iterator
from pathlib import Path, PurePosixPath

import pytest
import yaml

from tests.web._support import WebHarness, open_web_harness


@pytest.fixture
def workflow_app(tmp_path: Path) -> Iterator[WebHarness]:
    with open_web_harness(tmp_path, upload_max_bytes=4096) as harness:
        yield harness


def test_browser_workflow_from_project_creation_to_safe_zip_export(
    workflow_app: WebHarness,
) -> None:
    project_id = workflow_app.create_project(
        name="統合試験",
        title="合成軌跡データを用いた停止制御",
        values={
            "summary": "小型ロボットの停止制御を記述する．",
            "notes": "入力値は合成データである\n未確認の結果は生成しない",
            "objective": "停止位置の誤差を入力済みデータで評価する．",
            "method": "反射センサと二段階減速を用いる．",
            "system_design": "センサ，制御器，モータ，ロガーで構成する．",
            "experimental_conditions": "平坦面で8試行を行う．",
            "metrics": "停止誤差mmを用いる．",
            "results": "合成データでは平均誤差6.1 mmであった．",
            "limitations": "実機結果ではない．",
            "overall_instruction": "合成データであることを明示する．",
            "section_instructions": "discussion: 比較不足を明示する",
            "keywords": "停止制御, 合成データ",
        },
    )
    token = workflow_app.csrf_token()

    initial_editor = workflow_app.client.get(f"/projects/{project_id}")
    assert initial_editor.status_code == 200
    assert "合成軌跡データを用いた停止制御" in initial_editor.text
    assert "停止位置の誤差" in initial_editor.text
    assert "改善の助言" in initial_editor.text
    assert "#set page" in initial_editor.text

    upload = workflow_app.client.post(
        f"/projects/{project_id}/assets",
        data={"csrf_token": token, "description": "8試行の合成停止誤差"},
        files={
            "file": (
                "../synthetic-results.csv",
                b"trial,error_mm\n1,5.2\n2,-7.1\n",
                "text/csv",
            )
        },
        follow_redirects=False,
    )
    assert upload.status_code == 303

    reference = workflow_app.client.post(
        f"/projects/{project_id}/references",
        data={
            "csrf_token": token,
            "citation_key": "typst-docs",
            "title": "Typst Documentation",
            "authors": "Typst GmbH",
            "year": "2026",
        },
        follow_redirects=False,
    )
    assert reference.status_code == 303

    section = workflow_app.client.post(
        f"/projects/{project_id}/sections/introduction",
        data={
            "csrf_token": token,
            "content": "入力済みの事実だけを用いる統合試験である．",
            "instruction": "新規性を推測しない",
            "create_snapshot": "1",
        },
    )
    assert section.status_code == 200

    source = (
        '#set page(paper: "a4")\n'
        "= 統合試験\n"
        "入力済みの合成データだけを使用する @typst-docs.\n"
        '#bibliography("references.yml")\n'
    )
    source_save = workflow_app.client.post(
        f"/projects/{project_id}/source",
        data={"csrf_token": token, "source": source},
    )
    assert source_save.status_code == 200

    editor = workflow_app.client.get(f"/projects/{project_id}?section=introduction")
    assert "入力済みの事実だけを用いる統合試験" in editor.text
    assert "synthetic-results.csv" in editor.text
    assert "typst-docs" in editor.text
    assert "本文未使用" not in editor.text
    assert "manual-save" in editor.text

    source_download = workflow_app.client.get(f"/projects/{project_id}/source")
    assert source_download.status_code == 200
    assert source_download.text == source

    exported = workflow_app.client.get(f"/projects/{project_id}/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/zip"
    assert 'filename="-' not in exported.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = archive.namelist()
        assert names[:2] == ["project.yml", "main.typ"]
        assert len(names) == len(set(names))
        assert {"project.yml", "main.typ", "references.yml"}.issubset(names)
        assert "sections/introduction.typ" in names
        data_names = [name for name in names if name.startswith("data/")]
        assert len(data_names) == 1
        assert data_names[0].endswith(".csv")
        assert all(not PurePosixPath(name).is_absolute() for name in names)
        assert all(".." not in PurePosixPath(name).parts for name in names)
        manifest = yaml.safe_load(archive.read("project.yml"))
        assert manifest["id"] == project_id
        assert manifest["language"] == "ja"
        assert manifest["paper_spec"]["objective"] == "停止位置の誤差を入力済みデータで評価する．"
        assert archive.read("main.typ").decode("utf-8") == source
        references = yaml.safe_load(archive.read("references.yml"))
        assert references["typst-docs"]["title"] == "Typst Documentation"
        assert archive.read(data_names[0]).startswith(b"trial,error_mm")

    no_pdf = workflow_app.client.get(f"/projects/{project_id}/pdf")
    assert no_pdf.status_code == 404
