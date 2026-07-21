from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from paper_tools.schemas import (
    CompileResult,
    CompileStatus,
    GeneratedSection,
    GenerationRequest,
    GenerationResponse,
    OutlineSection,
    PaperOutline,
    PaperSpec,
    ReferenceSpec,
    TypstDocument,
)
from paper_tools.services.generation import generate_rule_based_response
from paper_tools.services.typst_compiler import TypstCompileService
from paper_tools.services.typst_renderer import TypstRenderingService, escape_typst


def test_typst_special_characters_are_escaped() -> None:
    raw = r"#let x = [a] $b$ *bold* _under_ @ref <tag> + - `code` \path"
    escaped = escape_typst(raw)

    for fragment in (
        r"\#let",
        r"\[a\]",
        r"\$b\$",
        r"\*bold\*",
        r"\u{0040}ref",
        r"\\path",
    ):
        assert fragment in escaped
    assert "@ref" not in escaped


def test_typst_render_escapes_injected_markup() -> None:
    spec = PaperSpec(title="#let secret = 1", summary="[unsafe] $math$")
    generated = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    document = TypstRenderingService().render(spec, generated)
    rendered_files = "\n".join(document.files.values())

    assert r"\#let secret \= 1" in document.source
    assert r"\[unsafe\] \$math\$" in rendered_files
    assert "#let secret = 1" not in rendered_files


def test_rendered_document_contains_posix_section_paths() -> None:
    spec = PaperSpec(summary="概要")
    generated = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    document = TypstRenderingService().render(spec, generated)

    assert "main.typ" in document.files
    assert all("\\" not in name for name in document.files)
    assert any(name.startswith("sections/") for name in document.files)


def test_renderer_allows_only_registered_citations_and_keeps_usage_in_main() -> None:
    spec = PaperSpec(
        language="en",
        template_id="generic-en",
        references=[
            ReferenceSpec(key="Known2026", title="Known work"),
            ReferenceSpec(key="path/key+1", title="Key requiring an explicit label"),
            ReferenceSpec(key="bad#key", title="Unsupported lexical key"),
        ],
    )
    generated = GenerationResponse(
        outline=PaperOutline(
            title="Citations",
            template_id="generic-en",
            language="en",
            sections=[
                OutlineSection(id="introduction", title="Introduction", order=0),
            ],
        ),
        sections=[
            GeneratedSection(
                id="introduction",
                title="Introduction",
                content=(
                    "Supported @known2026. Explicit @path/key+1; "
                    'missing @Missing2026 and markup #include "outside.typ". '
                    "Unsupported @bad#key."
                ),
            )
        ],
        provider_name="test",
    )

    document = TypstRenderingService().render(spec, generated)
    section = document.files["sections/introduction.typ"]

    assert "@Known2026." in section
    assert '#cite(label("path/key+1"));' in section
    assert "@Missing2026" not in section
    assert "@bad" not in section
    assert r"\u{0040}Missing2026" in section
    assert r"\#include" in section
    assert re.search(r"(?<!\\)#include", section) is None

    # Keep this extraction identical to the editor's lexical usage analysis.
    used_keys = {
        key.rstrip(".,;:!?，．、。")
        for key in re.findall(r"@([A-Za-z0-9_.:+/-]+)", document.source)
        if key.rstrip(".,;:!?，．、。")
    }
    assert used_keys == {"Known2026", "path/key+1", "Missing2026", "bad"}
    assert "// paper-tools-citations: @Known2026 @path/key+1 @Missing2026 @bad" in document.source


def test_registered_references_use_one_split_bibliography() -> None:
    spec = PaperSpec(
        language="en",
        template_id="generic-en",
        references=[ReferenceSpec(key="Known2026", title="Known work")],
    )
    generated = GenerationResponse(
        outline=PaperOutline(
            title="References",
            template_id="generic-en",
            language="en",
            sections=[OutlineSection(id="references", title="References", order=0)],
        ),
        sections=[
            GeneratedSection(
                id="references",
                title="References",
                content="A generated duplicate list must not be rendered.",
            )
        ],
        provider_name="test",
    )

    document = TypstRenderingService().render(spec, generated)

    assert '#include "sections/references.typ"' in document.source
    assert '#bibliography("references.yml")' not in document.source
    assert document.files["sections/references.typ"] == ('#bibliography("../references.yml")\n')
    assert sum(content.count("#bibliography") for content in document.files.values()) == 1
    assert not any("generated duplicate" in content for content in document.files.values())


def test_empty_reference_section_keeps_missing_reference_placeholder() -> None:
    spec = PaperSpec()
    generated = generate_rule_based_response(GenerationRequest(paper_spec=spec))

    document = TypstRenderingService().render(spec, generated)
    reference_source = document.files["sections/references.typ"]

    assert '#include "sections/references.typ"' in document.source
    assert "#bibliography" not in reference_source
    assert r"\[CITATION NEEDED:" in reference_source


@pytest.mark.parametrize(
    ("template_id", "language"),
    [
        ("engineering-two-column", "ja"),
        ("experiment-report", "ja"),
        ("generic-en", "en"),
        ("generic-ja", "ja"),
        ("literature-review", "ja"),
        ("research-proposal", "ja"),
        ("robotics-experiment", "ja"),
        ("short-paper", "ja"),
    ],
)
def test_every_template_includes_generated_section_files(
    template_id: str,
    language: str,
) -> None:
    spec = PaperSpec(language=language, template_id=template_id, title="Split document")
    generated = GenerationResponse(
        outline=PaperOutline(
            title="Split document",
            template_id=template_id,
            language=language,
            sections=[
                OutlineSection(id="abstract", title="Abstract", order=0),
                OutlineSection(id="introduction", title="Introduction", order=1),
            ],
        ),
        sections=[
            GeneratedSection(id="abstract", title="Abstract", content="ABSTRACTMARKER"),
            GeneratedSection(
                id="introduction",
                title="Introduction",
                content="BODYMARKER",
            ),
        ],
        provider_name="test",
    )

    document = TypstRenderingService().render(spec, generated)

    assert '#include "sections/abstract.typ"' in document.source
    assert '#include "sections/introduction.typ"' in document.source
    assert "ABSTRACTMARKER" not in document.source
    assert "BODYMARKER" not in document.source
    assert document.files["sections/abstract.typ"] == "ABSTRACTMARKER\n"
    assert document.files["sections/introduction.typ"] == "= Introduction\n\nBODYMARKER\n"


def test_missing_abstract_uses_safe_inline_placeholder() -> None:
    spec = PaperSpec(language="en", template_id="generic-en")
    generated = GenerationResponse(
        outline=PaperOutline(
            title="No abstract",
            template_id="generic-en",
            language="en",
            sections=[OutlineSection(id="introduction", title="Introduction", order=0)],
        ),
        sections=[
            GeneratedSection(id="introduction", title="Introduction", content="Body"),
        ],
        provider_name="test",
    )

    document = TypstRenderingService().render(spec, generated)

    assert '#include "sections/abstract.typ"' not in document.source
    assert r"\[TODO: Enter the abstract\]" in document.source
    assert "sections/abstract.typ" not in document.files


@pytest.mark.typst
@pytest.mark.skipif(shutil.which("typst") is None, reason="Typst CLI is not installed")
@pytest.mark.parametrize(
    ("template_id", "language"),
    [
        ("engineering-two-column", "ja"),
        ("experiment-report", "ja"),
        ("generic-en", "en"),
        ("generic-ja", "ja"),
        ("literature-review", "ja"),
        ("research-proposal", "ja"),
        ("robotics-experiment", "ja"),
        ("short-paper", "ja"),
    ],
)
def test_every_rendered_template_compiles_with_typst_when_available(
    tmp_path: Path,
    template_id: str,
    language: str,
) -> None:
    spec = PaperSpec(language=language, template_id=template_id, title="Compile test")
    generated = GenerationResponse(
        outline=PaperOutline(
            title="Compile test",
            template_id=template_id,
            language=language,
            sections=[
                OutlineSection(id="abstract", title="Abstract", order=0),
                OutlineSection(id="introduction", title="Introduction", order=1),
            ],
        ),
        sections=[
            GeneratedSection(id="abstract", title="Abstract", content="Summary."),
            GeneratedSection(id="introduction", title="Introduction", content="Body."),
        ],
        provider_name="test",
    )
    renderer = TypstRenderingService()
    document = renderer.render(spec, generated)
    renderer.write_document(document, tmp_path)

    result = TypstCompileService("typst").compile(
        tmp_path / "main.typ",
        tmp_path / "paper.pdf",
        project_root=tmp_path,
    )

    assert result.success, result.errors


def test_renderer_applies_japanese_punctuation_and_english_region() -> None:
    japanese = PaperSpec(
        title="入力，結果．",
        summary="目的，手法．",
        japanese_punctuation="、。",
    )
    japanese_generated = generate_rule_based_response(GenerationRequest(paper_spec=japanese))

    japanese_document = TypstRenderingService().render(japanese, japanese_generated)
    japanese_files = "\n".join(japanese_document.files.values())

    assert "入力、結果。" in japanese_document.source
    assert "目的、手法。" in japanese_files

    english = PaperSpec(
        language="en",
        template_id="generic-en",
        title="British manuscript",
        english_variant="british",
    )
    english_generated = generate_rule_based_response(GenerationRequest(paper_spec=english))

    english_document = TypstRenderingService().render(english, english_generated)

    assert 'lang: "en", region: "GB"' in english_document.source


def test_renderer_rejects_unsafe_section_id() -> None:
    spec = PaperSpec()
    generated = generate_rule_based_response(GenerationRequest(paper_spec=spec))
    generated.sections = [GeneratedSection(id="../bad", title="Bad", content="x")]

    with pytest.raises(ValueError, match="unsafe section"):
        TypstRenderingService().render(spec, generated)


def test_renderer_rejects_duplicate_section_paths() -> None:
    spec = PaperSpec()
    generated = generate_rule_based_response(GenerationRequest(paper_spec=spec))
    generated.sections = [
        GeneratedSection(id="introduction", title="First", content="x"),
        GeneratedSection(id="introduction", title="Second", content="y"),
    ]

    with pytest.raises(ValueError, match="duplicate section"):
        TypstRenderingService().render(spec, generated)


def test_write_document_stays_below_project(tmp_path: Path) -> None:
    document = TypstDocument(
        source="safe",
        template_id="generic-ja",
        sections=[],
        files={"main.typ": "safe", "sections/intro.typ": "= Intro"},
    )

    paths = TypstRenderingService().write_document(document, tmp_path)

    assert {path.relative_to(tmp_path).as_posix() for path in paths} == {
        "main.typ",
        "sections/intro.typ",
    }


def test_write_document_rejects_traversal(tmp_path: Path) -> None:
    document = TypstDocument(
        source="safe",
        template_id="generic-ja",
        sections=[],
        files={"../outside.typ": "unsafe"},
    )

    with pytest.raises(ValueError, match="unsafe document"):
        TypstRenderingService().write_document(document, tmp_path)


def _executable(tmp_path: Path) -> Path:
    executable = tmp_path / "typst-test"
    executable.write_text("fake", encoding="utf-8")
    return executable


def test_compile_success_uses_argument_array_and_moves_valid_pdf(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    output = tmp_path / "output" / "paper.pdf"
    main.write_text("= Paper", encoding="utf-8")
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def runner(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append((args, kwargs))
        Path(args[-1]).write_bytes(b"%PDF-1.7\n")
        return subprocess.CompletedProcess(args, 0, "compiled", "")

    service = TypstCompileService(executable, runner=runner)
    result = service.compile(main, output, project_root=tmp_path)

    assert result.status is CompileStatus.SUCCESS
    assert output.read_bytes().startswith(b"%PDF-")
    assert calls[0][0][:4] == [
        str(executable.resolve()),
        "compile",
        "--root",
        str(tmp_path.resolve()),
    ]
    assert "shell" not in calls[0][1]


def test_compile_failure_preserves_previous_pdf(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    output = tmp_path / "paper.pdf"
    main.write_text("broken", encoding="utf-8")
    output.write_bytes(b"%PDF-old")

    def runner(args: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args, 1, "", "error: main.typ:1: broken")

    result = TypstCompileService(executable, runner=runner).compile(
        main, output, project_root=tmp_path
    )

    assert result.status is CompileStatus.FAILED
    assert output.read_bytes() == b"%PDF-old"
    assert any("main.typ" in error for error in result.errors)


def test_compile_errors_are_bounded_for_storage_and_display(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    main.write_text("broken", encoding="utf-8")

    def runner(args: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        stderr = "\n".join(f"error: main.typ:{index}: {'界' * 10_000}" for index in range(30))
        return subprocess.CompletedProcess(args, 1, "", stderr)

    result = TypstCompileService(executable, runner=runner).compile(
        main,
        tmp_path / "paper.pdf",
        project_root=tmp_path,
    )

    assert len(result.errors) <= 20
    assert all(len(error.encode("utf-8")) <= 2_000 for error in result.errors)
    assert sum(len(error.encode("utf-8")) for error in result.errors) <= 20_000


def test_compile_timeout_preserves_previous_pdf(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    output = tmp_path / "paper.pdf"
    main.write_text("slow", encoding="utf-8")
    output.write_bytes(b"%PDF-old")

    def runner(args: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(args, 0.01, output="partial")

    result = TypstCompileService(executable, timeout=0.01, runner=runner).compile(
        main, output, project_root=tmp_path
    )

    assert result.status is CompileStatus.TIMEOUT
    assert output.read_bytes() == b"%PDF-old"


def test_compile_unavailable_is_nonfatal(tmp_path: Path) -> None:
    service = TypstCompileService("definitely-not-a-real-typst-command")
    result = service.compile(tmp_path / "main.typ", tmp_path / "paper.pdf", project_root=tmp_path)

    assert result.status is CompileStatus.UNAVAILABLE
    assert not result.success
    assert "インストール" in result.errors[0]


def test_compile_rejects_paths_outside_project(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    service = TypstCompileService(executable)

    with pytest.raises(ValueError, match="プロジェクト内"):
        service.build_command(
            tmp_path.parent / "outside.typ",
            tmp_path / "paper.pdf",
            project_root=tmp_path,
        )


def test_busy_compile_returns_clear_status(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    main.write_text("= x", encoding="utf-8")
    service = TypstCompileService(executable, concurrency_limit=1, queue_timeout=0)
    assert service._semaphore.acquire(blocking=False)
    try:
        result = service.compile(main, tmp_path / "paper.pdf", project_root=tmp_path)
    finally:
        service._semaphore.release()

    assert result.status is CompileStatus.BUSY


def test_compile_limit_is_shared_across_service_instances(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    first_main = tmp_path / "first.typ"
    second_main = tmp_path / "second.typ"
    first_main.write_text("= first", encoding="utf-8")
    second_main.write_text("= second", encoding="utf-8")
    started = threading.Event()
    release = threading.Event()
    first_result: list[CompileResult] = []

    def blocking_runner(args: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        started.set()
        assert release.wait(timeout=2)
        Path(args[-1]).write_bytes(b"%PDF-1.7\n")
        return subprocess.CompletedProcess(args, 0, "", "")

    first = TypstCompileService(executable, queue_timeout=0, runner=blocking_runner)
    second = TypstCompileService(executable, queue_timeout=0, runner=blocking_runner)
    thread = threading.Thread(
        target=lambda: first_result.append(
            first.compile(first_main, tmp_path / "first.pdf", project_root=tmp_path)
        )
    )
    thread.start()
    assert started.wait(timeout=1)
    try:
        busy = second.compile(second_main, tmp_path / "second.pdf", project_root=tmp_path)
    finally:
        release.set()
        thread.join(timeout=2)

    assert busy.status is CompileStatus.BUSY
    assert first_result and first_result[0].success


def test_async_compile_cancellation_terminates_process_and_discards_output(
    tmp_path: Path,
) -> None:
    main = tmp_path / "main.typ"
    output = tmp_path / "paper.pdf"
    started = tmp_path / "started"
    completed = tmp_path / "completed"
    main.write_text("= slow", encoding="utf-8")
    output.write_bytes(b"%PDF-old")
    (tmp_path / "compile").write_text(
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
    service = TypstCompileService(sys.executable, timeout=60)

    async def cancel_after_start() -> None:
        task = asyncio.create_task(service.compile_async(main, output, project_root=tmp_path))
        for _ in range(200):
            if started.exists():
                break
            await asyncio.sleep(0.01)
        assert started.exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    before = time.monotonic()
    asyncio.run(cancel_after_start())

    assert time.monotonic() - before < 3
    assert output.read_bytes() == b"%PDF-old"
    assert not completed.exists()
    assert not list(tmp_path.glob(".paper-tools-*.pdf"))


def test_async_compile_delegates_to_safe_compiler(tmp_path: Path) -> None:
    executable = _executable(tmp_path)
    main = tmp_path / "main.typ"
    output = tmp_path / "paper.pdf"
    main.write_text("= x", encoding="utf-8")

    def runner(args: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        Path(args[-1]).write_bytes(b"%PDF-1.7\n")
        return subprocess.CompletedProcess(args, 0, "", "")

    result = asyncio.run(
        TypstCompileService(executable, runner=runner).compile_async(
            main, output, project_root=tmp_path
        )
    )

    assert result.success
