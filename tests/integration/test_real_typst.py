from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from paper_tools.schemas import GenerationRequest, PaperSpec
from paper_tools.services.generation import generate_rule_based_response
from paper_tools.services.typst_compiler import TypstCompileService
from paper_tools.services.typst_renderer import TypstRenderingService

_TYPST = shutil.which("typst")
_TEMPLATES = (
    ("generic-ja", "ja"),
    ("generic-en", "en"),
    ("engineering-two-column", "en"),
    ("robotics-experiment", "ja"),
    ("short-paper", "ja"),
    ("literature-review", "ja"),
    ("research-proposal", "ja"),
    ("experiment-report", "ja"),
)


@pytest.mark.typst
@pytest.mark.skipif(_TYPST is None, reason="Typst CLI is not installed or not on PATH")
@pytest.mark.parametrize(("template_id", "language"), _TEMPLATES)
def test_every_bundled_template_compiles_with_real_typst(
    tmp_path: Path,
    template_id: str,
    language: str,
) -> None:
    spec = PaperSpec(
        title="実Typst回帰試験" if language == "ja" else "Real Typst Regression",
        language=language,
        template_id=template_id,
        objective="入力済み情報だけで構文を確認する．",
        method="決定的な規則ベース生成を用いる．",
    )
    response = generate_rule_based_response(GenerationRequest(paper_spec=spec))
    renderer = TypstRenderingService()
    document = renderer.render(spec, response)
    project_dir = tmp_path / template_id
    renderer.write_document(document, project_dir)

    result = TypstCompileService(_TYPST or "typst").compile(
        project_dir / "main.typ",
        project_dir / "paper.pdf",
        project_root=project_dir,
    )

    assert result.success, "\n".join(result.errors)
    assert (project_dir / "paper.pdf").read_bytes().startswith(b"%PDF-")
