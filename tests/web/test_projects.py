from __future__ import annotations

import json
import re
from typing import Any

import pytest
import yaml

from paper_tools.models import GenerationRun
from paper_tools.providers import MockProvider
from paper_tools.schemas import GenerationRequest, GenerationResponse
from paper_tools.services.assets import AssetService
from paper_tools.services.projects import ProjectService
from paper_tools.services.references import ReferenceService
from paper_tools.services.workflow import PaperWorkflowService
from tests.web._support import WebHarness


def test_create_japanese_and_english_projects_with_template_fallback(
    web_app: WebHarness,
) -> None:
    ja_id = web_app.create_project(
        name="日本語プロジェクト",
        title="安全な移動制御",
        language="ja",
    )
    en_id = web_app.create_project(
        name="English project",
        title="Synthetic Control Study",
        language="en",
        template_id="generic-ja",
    )

    project_list = web_app.client.get("/projects")
    assert project_list.status_code == 200
    assert "日本語プロジェクト" in project_list.text
    assert "English project" in project_list.text
    assert "generic-ja" in project_list.text
    assert "generic-en" in project_list.text

    for project_id, expected_title in (
        (ja_id, "安全な移動制御"),
        (en_id, "Synthetic Control Study"),
    ):
        editor = web_app.client.get(f"/projects/{project_id}")
        assert editor.status_code == 200
        assert expected_title in editor.text
        assert "Typstソースを直接編集" in editor.text
        assert "改善の助言" in editor.text

    with web_app.database.session() as session:
        ja_project = ProjectService(session).get_project(ja_id)
        en_project = ProjectService(session).get_project(en_id)
        assert ja_project.language == "ja"
        assert ja_project.template_id == "generic-ja"
        assert ja_project.authors[0].name == "試験 著者"
        assert en_project.language == "en"
        assert en_project.template_id == "generic-en"
        assert en_project.typst_source
        assert any(section.slug == "abstract" for section in en_project.sections)


def test_external_initial_generation_is_submitted_as_a_background_job(
    web_app: WebHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_generate = PaperWorkflowService.generate_project
    requested_providers: list[str | None] = []

    async def recording_generate(
        workflow: PaperWorkflowService,
        project_id: str,
        *args: Any,
        **kwargs: Any,
    ) -> GenerationResponse:
        requested_providers.append(kwargs.get("provider_name"))
        kwargs["provider_name"] = "rule-based"
        return await original_generate(workflow, project_id, *args, **kwargs)

    monkeypatch.setattr(PaperWorkflowService, "generate_project", recording_generate)

    project_id = web_app.create_project(
        name="Queued initial generation",
        values={"provider": "ollama"},
    )
    status = web_app.app.state.jobs.current_for_project(project_id)

    assert status is not None
    assert status.operation == "initial-generate"
    assert "完了" in web_app.wait_for_job(status.id)
    assert requested_providers == ["ollama"]
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        assert project.status == "completed"
        assert project.sections


def test_generation_metadata_recommendations_and_history_remain_visible(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(
        name="Auditable generation",
        values={"presets": ["academic", "cautious"]},
    )
    token = web_app.csrf_token()

    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        run = next(item for item in project.generation_runs if item.operation == "generate")
        assert "客観的で学術論文" in run.instruction
        assert "過剰な主張" in run.instruction
        assert run.result_data["pre_generation_advice_ids"]
        assert run.result_data["suggested_figures"]
        provenance = run.result_data["provenance"]
        assert provenance
        assert any(
            segment.get("origin") == "user"
            for segments in provenance.values()
            for segment in segments
        )
        recommendation_titles = {
            item.title for item in project.advice if item.title.startswith("テンプレート推奨")
        }
        assert recommendation_titles

    saved = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={
            "csrf_token": token,
            "content": "履歴と提案を保持する手動編集である．",
            "instruction": "入力済み事実だけを用いる",
            "create_snapshot": "1",
        },
    )
    assert saved.status_code == 200
    current_source = web_app.client.get(f"/projects/{project_id}/source").text
    direct_source = current_source + "\n// direct-source-history-marker\n"
    assert (
        web_app.client.post(
            f"/projects/{project_id}/source",
            data={"csrf_token": token, "source": direct_source},
        ).status_code
        == 200
    )

    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        assert recommendation_titles.issubset({item.title for item in project.advice})
        assert any(run.operation == "source-manual-save" for run in project.generation_runs)
        session.add(
            GenerationRun(
                project_id=project_id,
                operation="provider-failure-regression",
                provider="test-provider",
                status="failed",
                message="永続エラー表示の回帰試験",
                error_message="persistent-error-marker",
            )
        )

    editor = web_app.client.get(f"/projects/{project_id}")
    assert "現在のTypstソースとの差分" in editor.text
    assert "現在版との差分" in editor.text
    assert "persistent-error-marker" in editor.text


def test_create_project_keeps_author_fields_aligned_when_a_name_is_blank(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(
        name="Author alignment",
        language="en",
        values={
            "author_name": ["First Author", "", "Third Author"],
            "author_affiliation": ["First Lab", "Unused Lab", "Third Lab"],
            "author_email": [
                "first@example.invalid",
                "unused@example.invalid",
                "third@example.invalid",
            ],
            "author_orcid": ["0000-0001", "0000-unused", "0000-0003"],
            "author_corresponding": ["2"],
        },
    )

    with web_app.database.session() as session:
        authors = ProjectService(session).get_project(project_id).authors
        assert [author.name for author in authors] == ["First Author", "Third Author"]
        assert [author.affiliation for author in authors] == ["First Lab", "Third Lab"]
        assert [author.email for author in authors] == [
            "first@example.invalid",
            "third@example.invalid",
        ]
        assert [author.orcid for author in authors] == ["0000-0001", "0000-0003"]
        assert [author.corresponding for author in authors] == [False, True]
        assert [author.position for author in authors] == [0, 1]


def test_editor_can_replace_and_reorder_authors(web_app: WebHarness) -> None:
    project_id = web_app.create_project(name="Editable authors", language="en")

    updated = web_app.client.post(
        f"/projects/{project_id}/authors",
        data={
            "csrf_token": web_app.csrf_token(),
            "author_name": ["Second Author", "First Author"],
            "author_affiliation": ["Second Lab", "First Lab"],
            "author_email": ["second@example.invalid", "first@example.invalid"],
            "author_orcid": ["0000-0002", "0000-0001"],
            "author_corresponding": ["1"],
        },
        follow_redirects=False,
    )

    assert updated.status_code == 303
    editor = web_app.client.get(updated.headers["location"])
    assert "Second Author" in editor.text
    assert "First Author" in editor.text
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        assert [author.name for author in project.authors] == [
            "Second Author",
            "First Author",
        ]
        assert [author.corresponding for author in project.authors] == [False, True]
        assert "Second Author" in project.typst_source


def test_editor_autosave_snapshot_html_escaping_and_source_edit(web_app: WebHarness) -> None:
    project_id = web_app.create_project(name="Autosave")
    token = web_app.csrf_token()
    content = "更新した概要 <script>alert('unsafe')</script>"

    first = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={"csrf_token": token, "content": content, "instruction": "簡潔にする"},
    )
    assert first.status_code == 200
    assert "保存済み" in first.text

    duplicate = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={"csrf_token": token, "content": content, "instruction": "簡潔にする"},
    )
    assert duplicate.status_code == 200
    assert "変更なし" in duplicate.text

    snapshot = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={
            "csrf_token": token,
            "content": f"{content}\n手動保存版",
            "instruction": "簡潔にする",
            "create_snapshot": "1",
        },
    )
    assert snapshot.status_code == 200

    editor = web_app.client.get(f"/projects/{project_id}?section=abstract")
    assert "&lt;script&gt;alert" in editor.text
    assert "manual-save" in editor.text

    source = '#set text(lang: "ja")\n= 安全な原稿\n'
    saved_source = web_app.client.post(
        f"/projects/{project_id}/source",
        data={"csrf_token": token, "source": source},
    )
    assert saved_source.status_code == 200
    assert "Typstソースを保存しました" in saved_source.text

    downloaded = web_app.client.get(f"/projects/{project_id}/source")
    assert downloaded.status_code == 200
    assert downloaded.text == source
    assert 'filename="main.typ"' in downloaded.headers["content-disposition"]

    unsafe_source = web_app.client.post(
        f"/projects/{project_id}/source",
        data={"csrf_token": token, "source": "before\x00after"},
    )
    assert unsafe_source.status_code == 400
    assert "使用できない文字" in unsafe_source.text


def test_advice_ids_stay_actionable_after_section_refresh(web_app: WebHarness) -> None:
    project_id = web_app.create_project(name="Stable advice actions", language="en")
    token = web_app.csrf_token()
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        before = {
            (item.category, item.title, item.target_section): item.id for item in project.advice
        }

    saved = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={
            "csrf_token": token,
            "content": "A verified browser-edit marker.",
            "instruction": "Keep supplied facts only.",
        },
    )
    assert saved.status_code == 200
    assert saved.headers["hx-trigger"] == "paperAdviceChanged"

    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        after = {
            (item.category, item.title, item.target_section): item.id for item in project.advice
        }
    unchanged = set(before) & set(after)
    assert unchanged, {"before": set(before), "after": set(after)}
    assert all(before[key] == after[key] for key in unchanged)

    advice_id = before[next(iter(unchanged))]
    resolved = web_app.client.post(
        f"/projects/{project_id}/advice/{advice_id}/resolve",
        data={"csrf_token": token},
    )
    assert resolved.status_code == 200
    assert "解決済み" in resolved.text
    assert resolved.headers["hx-trigger"] == "paperAdviceChanged"

    advice_panel = web_app.client.get(f"/projects/{project_id}/advice-panel")
    assert advice_panel.status_code == 200
    assert "改善の助言" in advice_panel.text
    section_list = web_app.client.get(
        f"/projects/{project_id}/section-list",
        headers={"HX-Current-URL": f"http://testserver/projects/{project_id}?section=abstract"},
    )
    assert section_list.status_code == 200
    assert 'data-section-slug="abstract"' in section_list.text
    assert "section-link active" in section_list.text


def test_section_autosave_rerenders_source_and_regeneration_keeps_instruction(
    web_app: WebHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = web_app.create_project(name="Section regeneration", language="en")
    token = web_app.csrf_token()
    initial_source = web_app.client.get(f"/projects/{project_id}/source").text
    content = "A manually verified abstract marker appears only after autosave."
    instruction = "Keep the verified marker and avoid unsupported claims."

    saved = web_app.client.post(
        f"/projects/{project_id}/sections/abstract",
        data={"csrf_token": token, "content": content, "instruction": instruction},
    )

    assert saved.status_code == 200
    rerendered_source = web_app.client.get(f"/projects/{project_id}/source").text
    assert rerendered_source != initial_source
    assert '#include "sections/abstract.typ"' in rerendered_source
    assert content in (
        web_app.settings.projects_dir / project_id / "sections" / "abstract.typ"
    ).read_text(encoding="utf-8")

    requests: list[GenerationRequest] = []

    class RecordingProvider(MockProvider):
        async def generate(self, request: GenerationRequest) -> GenerationResponse:
            requests.append(request)
            return await super().generate(request)

    provider = RecordingProvider(
        response=json.dumps(
            {
                "sections": [
                    {
                        "id": "abstract",
                        "title": "Abstract",
                        "content": "A regenerated and verified abstract.",
                    }
                ]
            }
        )
    )

    def create_provider(
        _workflow: PaperWorkflowService,
        _name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> RecordingProvider:
        assert allow_fallback
        return provider

    monkeypatch.setattr(PaperWorkflowService, "create_provider", create_provider)
    job_id = web_app.submit_job(f"/projects/{project_id}/sections/abstract/regenerate")
    terminal = web_app.wait_for_job(job_id)
    regenerated = web_app.client.get(f"/projects/{project_id}?section=abstract")

    assert regenerated.status_code == 200
    assert "完了" in terminal
    assert len(requests) == 1
    assert requests[0].target_section == "abstract"
    assert requests[0].instruction == instruction
    assert "A regenerated and verified abstract." in regenerated.text
    with web_app.database.session() as session:
        section = next(
            item
            for item in ProjectService(session).get_project(project_id).sections
            if item.slug == "abstract"
        )
        assert section.instruction == instruction


def test_outline_only_regeneration_preserves_body_and_restores_structure(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Outline regeneration")
    marker = "This manually verified body must survive outline regeneration."
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        abstract = next(section for section in project.sections if section.slug == "abstract")
        ProjectService(session).save_section(project_id, "abstract", content=marker)
        abstract.title = "Temporary title"

    job_id = web_app.submit_job(f"/projects/{project_id}/outline/regenerate")
    assert "完了" in web_app.wait_for_job(job_id)
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        abstract = next(section for section in project.sections if section.slug == "abstract")
        assert abstract.title == "概要"
        assert abstract.content == marker
        assert [section.position for section in project.sections] == list(
            range(len(project.sections))
        )
        assert any(run.operation == "outline-regenerate" for run in project.generation_runs)
    editor = web_app.client.get(f"/projects/{project_id}")
    assert "構成だけ再生成" in editor.text


def test_selection_transform_replaces_only_utf16_range(
    web_app: WebHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = web_app.create_project(name="Selection transform", language="en")
    content = "Before 😀 selected text after."
    selected_text = "selected text"
    with web_app.database.session() as session:
        ProjectService(session).save_section(project_id, "abstract", content=content)
    web_app.settings.generation_provider = "ollama"
    requests: list[GenerationRequest] = []

    class RecordingProvider(MockProvider):
        async def generate(self, request: GenerationRequest) -> GenerationResponse:
            requests.append(request)
            return await super().generate(request)

    provider = RecordingProvider(
        response=json.dumps(
            {
                "sections": [
                    {
                        "id": "abstract",
                        "title": "Abstract",
                        "content": "Revised selection.",
                    }
                ]
            }
        )
    )

    def create_provider(
        _workflow: PaperWorkflowService,
        _name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> RecordingProvider:
        assert not allow_fallback
        return provider

    monkeypatch.setattr(PaperWorkflowService, "create_provider", create_provider)
    start_index = content.index(selected_text)
    end_index = start_index + len(selected_text)
    start_utf16 = len(content[:start_index].encode("utf-16-le")) // 2
    end_utf16 = len(content[:end_index].encode("utf-16-le")) // 2

    job_id = web_app.submit_job(
        f"/projects/{project_id}/sections/abstract/transform",
        data={
            "operation": "improve",
            "selection_start": str(start_utf16),
            "selection_end": str(end_utf16),
            "selected_text": selected_text,
        },
    )
    terminal = web_app.wait_for_job(job_id)
    transformed = web_app.client.get(f"/projects/{project_id}?section=abstract")

    assert transformed.status_code == 200
    assert "完了" in terminal
    assert "Before 😀 Revised selection." in transformed.text
    assert "after." in transformed.text
    assert len(requests) == 1
    assert requests[0].existing_sections == {"abstract": selected_text}
    assert requests[0].paper_spec.summary == ""
    with web_app.database.session() as session:
        section = next(
            item
            for item in ProjectService(session).get_project(project_id).sections
            if item.slug == "abstract"
        )
        assert section.content.startswith("Before 😀 Revised selection.")
        assert section.content.endswith("after.")
        assert any(version.operation == "selection-transform-after" for version in section.versions)


def test_selection_transform_rejects_stale_or_tampered_selection(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Stale selection", language="en")
    web_app.settings.generation_provider = "ollama"
    token = web_app.csrf_token()

    response = web_app.client.post(
        f"/projects/{project_id}/sections/abstract/transform",
        data={
            "csrf_token": token,
            "operation": "improve",
            "selection_start": "0",
            "selection_end": "4",
            "selected_text": "not the current text",
        },
    )

    assert response.status_code == 400
    assert "保存完了後" in response.text


def test_full_manuscript_translation_updates_language_title_sections_and_template(
    web_app: WebHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id = web_app.create_project(
        name="Full translation",
        title="安全な日本語原稿",
        values={"keywords": "制御, 評価"},
    )
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        translated_sections = [
            {
                "id": section.slug,
                "title": f"English {section.slug}",
                "content": " ".join(
                    [
                        f"Translated body for {section.slug}.",
                        *re.findall(
                            r"\[(?:TODO|DATA NEEDED|FIGURE NEEDED|CITATION NEEDED|VERIFY):[^\]]*\]",
                            section.content,
                        ),
                    ]
                ),
            }
            for section in project.sections
        ]
    provider = MockProvider(
        response=json.dumps(
            {
                "document_title": "Safe English Manuscript",
                "keywords": ["control", "evaluation"],
                "sections": translated_sections,
            }
        )
    )

    def create_provider(
        _workflow: PaperWorkflowService,
        _name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> MockProvider:
        assert not allow_fallback
        return provider

    web_app.settings.generation_provider = "ollama"
    monkeypatch.setattr(PaperWorkflowService, "create_provider", create_provider)
    job_id = web_app.submit_job(
        f"/projects/{project_id}/translate",
        data={"target_language": "en"},
    )
    terminal = web_app.wait_for_job(job_id)

    assert "完了" in terminal
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        assert project.language == "en"
        assert project.template_id == "generic-en"
        assert project.title == "Safe English Manuscript"
        assert project.paper_spec is not None
        assert project.paper_spec.keywords == ["control", "evaluation"]
        assert all(section.content.startswith("Translated body") for section in project.sections)
        assert any(
            run.operation == "translate-ja-to-en" and run.status == "completed"
            for run in project.generation_runs
        )
        assert 'lang: "en", region: "US"' in project.typst_source
    editor = web_app.client.get(f"/projects/{project_id}")
    assert "原稿全体を日本語化" in editor.text


def test_full_translation_without_llm_shows_configuration_guidance(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Translation guidance")
    editor = web_app.client.get(f"/projects/{project_id}")

    assert "原稿全体を英語化" in editor.text
    assert "原稿全体の翻訳は設定画面でLLMを選択" in editor.text
    response = web_app.client.post(
        f"/projects/{project_id}/translate",
        data={"csrf_token": web_app.csrf_token(), "target_language": "en"},
    )
    assert response.status_code == 400
    assert "設定画面" in response.text


def test_project_inputs_autosave_updates_rendered_source_and_advice(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(
        name="Incomplete inputs",
        language="en",
        values={"objective": "", "experimental_conditions": "", "metrics": ""},
    )
    initial_source = web_app.client.get(f"/projects/{project_id}/source").text
    with web_app.database.session() as session:
        initial_advice = {
            item.title for item in ProjectService(session).get_project(project_id).advice
        }
    assert "研究目的を明確にしてください" in initial_advice

    updated = web_app.client.post(
        f"/projects/{project_id}/inputs",
        data={
            "csrf_token": web_app.csrf_token(),
            "name": "Completed inputs",
            "title": "Updated Input Study",
            "research_field": "Robotics",
            "page_target": "8",
            "audience": "Controls researchers",
            "venue_note": "Regression venue",
            "summary": "A bounded regression study.",
            "achievement": "Inputs can be revised.",
            "key_message": "The edited inputs are authoritative.",
            "background": "A local workflow needs editable inputs.",
            "problem": "Stale inputs produce stale output.",
            "objective": "Verify that input autosave refreshes the project.",
            "novelty": "A focused route regression.",
            "method": "Submit the complete form and inspect persisted output.",
            "system_design": "A browser route, database, and renderer.",
            "experimental_conditions": "One deterministic local request.",
            "metrics": "Persisted source and advice titles.",
            "results": "Both outputs changed as expected.",
            "discussion": "The route synchronizes derived state.",
            "limitations": "This is a synthetic regression test.",
            "conclusion": "Input changes are reflected locally.",
            "future_work": "Exercise additional templates.",
            "overall_instruction": "Use only the submitted facts.",
            "notes": "No external provider\nNo invented measurements",
            "keywords": "autosave, regression",
        },
    )

    assert updated.status_code == 200
    assert "入力情報を保存しました" in updated.text
    assert updated.headers["hx-trigger"] == "paperAdviceChanged"
    updated_source = web_app.client.get(f"/projects/{project_id}/source").text
    assert updated_source != initial_source
    assert "Updated Input Study" in updated_source
    with web_app.database.session() as session:
        project = ProjectService(session).get_project(project_id)
        assert project.name == "Completed inputs"
        assert project.paper_spec is not None
        assert project.paper_spec.objective == "Verify that input autosave refreshes the project."
        assert "研究目的を明確にしてください" not in {item.title for item in project.advice}


def test_advice_targets_always_reference_sections_in_the_selected_template(
    web_app: WebHarness,
) -> None:
    template_languages = {
        "generic-ja": "ja",
        "generic-en": "en",
        "engineering-two-column": "ja",
        "robotics-experiment": "ja",
        "short-paper": "ja",
        "literature-review": "ja",
        "research-proposal": "ja",
        "experiment-report": "ja",
    }
    for template_id, language in template_languages.items():
        project_id = web_app.create_project(
            name=f"Advice targets {template_id}",
            language=language,
            template_id=template_id,
            values={"objective": "", "results": "improved", "method": "controller"},
        )
        with web_app.database.session() as session:
            project = ProjectService(session).get_project(project_id)
            section_slugs = {section.slug for section in project.sections}
            assert all(
                item.target_section is None or item.target_section in section_slugs
                for item in project.advice
            )
        invalid = web_app.client.get(f"/projects/{project_id}?section=missing-section")
        assert invalid.status_code == 404


def test_remote_ollama_url_is_disclosed_as_external_transfer(web_app: WebHarness) -> None:
    project_id = web_app.create_project(name="Remote Ollama disclosure")
    web_app.settings.generation_provider = "ollama"
    web_app.settings.ollama_url = "https://ollama.example.invalid"

    editor = web_app.client.get(f"/projects/{project_id}")

    assert editor.status_code == 200
    assert "論文内容が設定済みの外部接続先へ送信されます" in editor.text
    assert "設定済みローカルOllama" not in editor.text


def test_reference_routes_cover_add_import_update_download_and_delete(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Reference routes", language="en")
    token = web_app.csrf_token()
    added = web_app.client.post(
        f"/projects/{project_id}/references",
        data={
            "csrf_token": token,
            "citation_key": "Route2026",
            "entry_type": "article",
            "title": "Original Route Reference",
            "authors": "Ada Example; Grace Example",
            "year": "2026",
            "venue": "Route Journal",
            "doi": "10.0000/route",
        },
        follow_redirects=False,
    )
    assert added.status_code == 303

    imported = web_app.client.post(
        f"/projects/{project_id}/references/import",
        data={
            "csrf_token": token,
            "bibtex": """
@inproceedings{Imported2025,
  title = {Imported Browser Reference},
  author = {Lin Example and Ren Example},
  year = {2025},
  booktitle = {Browser Conference}
}
""",
        },
        follow_redirects=False,
    )
    assert imported.status_code == 303
    assert "reference_created=1" in imported.headers["location"]

    with web_app.database.session() as session:
        references = ReferenceService(session).list_references(project_id)
        reference_ids = {item.citation_key: item.id for item in references}
    updated = web_app.client.post(
        f"/projects/{project_id}/references/{reference_ids['Route2026']}/update",
        data={
            "csrf_token": token,
            "citation_key": "Route2026Updated",
            "entry_type": "book",
            "title": "Updated Route Reference",
            "authors": "Ada Example",
            "year": "2024",
            "venue": "Updated Publisher",
            "volume": "2",
            "issue": "1",
            "pages": "10--20",
            "doi": "10.0000/updated",
            "url": "https://example.invalid/reference",
            "note": "Checked by route test",
        },
        follow_redirects=False,
    )
    assert updated.status_code == 303

    bibtex = web_app.client.get(f"/projects/{project_id}/references.bib")
    assert bibtex.status_code == 200
    assert 'filename="references.bib"' in bibtex.headers["content-disposition"]
    assert "Route2026Updated" in bibtex.text
    assert "Updated Route Reference" in bibtex.text
    assert "Imported2025" in bibtex.text

    hayagriva = web_app.client.get(f"/projects/{project_id}/references.yml")
    assert hayagriva.status_code == 200
    assert 'filename="references.yml"' in hayagriva.headers["content-disposition"]
    parsed = yaml.safe_load(hayagriva.text)
    assert parsed["Route2026Updated"]["title"] == "Updated Route Reference"
    assert parsed["Imported2025"]["title"] == "Imported Browser Reference"

    deleted = web_app.client.post(
        f"/projects/{project_id}/references/{reference_ids['Imported2025']}/delete",
        data={"csrf_token": token},
        follow_redirects=False,
    )
    assert deleted.status_code == 303
    with web_app.database.session() as session:
        assert [
            item.citation_key for item in ReferenceService(session).list_references(project_id)
        ] == ["Route2026Updated"]


def test_asset_routes_reject_bad_signature_and_update_then_delete_metadata(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Asset routes", language="en")
    token = web_app.csrf_token()

    invalid = web_app.client.post(
        f"/projects/{project_id}/assets",
        data={"csrf_token": token, "kind": "figure"},
        files={"file": ("forged.png", b"not a png", "image/png")},
    )
    assert invalid.status_code == 400
    assert "署名" in invalid.text

    uploaded = web_app.client.post(
        f"/projects/{project_id}/assets",
        data={
            "csrf_token": token,
            "kind": "figure",
            "description": "Initial description",
        },
        files={"file": ("verified.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        follow_redirects=False,
    )
    assert uploaded.status_code == 303
    with web_app.database.session() as session:
        service = AssetService(session, web_app.settings)
        asset = service.list_assets(project_id)[0]
        asset_id = asset.id
        asset_path = service.asset_path(asset)
    assert asset_path.is_file()
    downloaded = web_app.client.get(f"/projects/{project_id}/assets/{asset_id}")
    assert downloaded.status_code == 200
    assert downloaded.content == b"\x89PNG\r\n\x1a\n"
    assert downloaded.headers["content-type"] == "image/png"
    assert "verified.png" in downloaded.headers["content-disposition"]

    updated = web_app.client.post(
        f"/projects/{project_id}/assets/{asset_id}/update",
        data={
            "csrf_token": token,
            "display_name": "Verified result plot",
            "kind": "graph",
            "description": "Updated metadata",
            "purpose": "Report the deterministic result",
            "target_section": "results",
            "source": "Synthetic local data",
            "is_original": "1",
        },
        follow_redirects=False,
    )
    assert updated.status_code == 303
    with web_app.database.session() as session:
        asset = AssetService(session, web_app.settings).get_asset(project_id, asset_id)
        assert asset.display_name == "Verified result plot"
        assert asset.kind == "graph"
        assert asset.description == "Updated metadata"
        assert asset.purpose == "Report the deterministic result"
        assert asset.target_section == "results"
        assert asset.source == "Synthetic local data"
        assert asset.is_original is True

    deleted = web_app.client.post(
        f"/projects/{project_id}/assets/{asset_id}/delete",
        data={"csrf_token": token},
        follow_redirects=False,
    )
    assert deleted.status_code == 303
    assert not asset_path.exists()
    with web_app.database.session() as session:
        assert AssetService(session, web_app.settings).list_assets(project_id) == []


def test_duplicate_project_copies_sections_references_and_assets(web_app: WebHarness) -> None:
    project_id = web_app.create_project(
        name="Duplicate source",
        title="Duplicate Study",
        language="en",
    )
    token = web_app.csrf_token()
    content = "A section body that must survive duplication."
    instruction = "Preserve this duplication instruction."
    assert (
        web_app.client.post(
            f"/projects/{project_id}/sections/abstract",
            data={"csrf_token": token, "content": content, "instruction": instruction},
        ).status_code
        == 200
    )
    assert (
        web_app.client.post(
            f"/projects/{project_id}/references",
            data={
                "csrf_token": token,
                "citation_key": "Duplicate2026",
                "title": "Reference copied to duplicate",
                "year": "2026",
            },
            follow_redirects=False,
        ).status_code
        == 303
    )
    assert (
        web_app.client.post(
            f"/projects/{project_id}/assets",
            data={"csrf_token": token, "description": "Asset copied to duplicate"},
            files={"file": ("copy.txt", b"copied bytes", "text/plain")},
            follow_redirects=False,
        ).status_code
        == 303
    )

    duplicated = web_app.client.post(
        f"/projects/{project_id}/duplicate",
        data={"csrf_token": token},
        follow_redirects=False,
    )
    assert duplicated.status_code == 303
    duplicate_id = duplicated.headers["location"].removeprefix("/projects/")
    assert duplicate_id != project_id

    with web_app.database.session() as session:
        source = ProjectService(session).get_project(project_id)
        duplicate = ProjectService(session).get_project(duplicate_id)
        assert duplicate.name == f"{source.name}（複製）"
        assert duplicate.title == source.title
        duplicate_abstract = next(item for item in duplicate.sections if item.slug == "abstract")
        assert duplicate_abstract.content == content
        assert duplicate_abstract.instruction == instruction
        assert [item.citation_key for item in duplicate.references] == ["Duplicate2026"]
        assert len(duplicate.assets) == 1
        assert duplicate.assets[0].id != source.assets[0].id
        assert (
            AssetService(session, web_app.settings).read_asset(duplicate_id, duplicate.assets[0].id)
            == b"copied bytes"
        )
        assert '#include "sections/abstract.typ"' in duplicate.typst_source
        assert content in (
            web_app.settings.projects_dir / duplicate_id / "sections" / "abstract.typ"
        ).read_text(encoding="utf-8")


def test_upload_rejection_reference_validation_and_delete_confirmation(
    web_app: WebHarness,
) -> None:
    project_id = web_app.create_project(name="Managed project")
    token = web_app.csrf_token()

    forbidden = web_app.client.post(
        f"/projects/{project_id}/assets",
        data={"csrf_token": token},
        files={"file": ("../../payload.exe", b"MZ", "application/octet-stream")},
    )
    assert forbidden.status_code == 400
    assert "許可されていない拡張子" in forbidden.text

    oversized = web_app.client.post(
        f"/projects/{project_id}/assets",
        data={"csrf_token": token},
        files={"file": ("large.csv", b"x" * 1025, "text/csv")},
    )
    assert oversized.status_code == 400
    assert "サイズが上限" in oversized.text

    reference = web_app.client.post(
        f"/projects/{project_id}/references",
        data={
            "csrf_token": token,
            "citation_key": "verified2026",
            "title": "A Verified Test Reference",
            "authors": "Ada Example; Grace Example",
            "year": "2026",
        },
        follow_redirects=False,
    )
    assert reference.status_code == 303

    editor = web_app.client.get(f"/projects/{project_id}")
    assert "verified2026" in editor.text
    assert "A Verified Test Reference" in editor.text
    assert "本文未使用" in editor.text

    duplicate = web_app.client.post(
        f"/projects/{project_id}/references",
        data={
            "csrf_token": token,
            "citation_key": "verified2026",
            "title": "Duplicate",
            "year": "2026",
        },
    )
    assert duplicate.status_code == 400
    assert "既に登録" in duplicate.text

    invalid_year = web_app.client.post(
        f"/projects/{project_id}/references",
        data={
            "csrf_token": token,
            "citation_key": "bad-year",
            "title": "Invalid Year",
            "year": "not-a-year",
        },
    )
    assert invalid_year.status_code == 400
    assert "年は4桁" in invalid_year.text

    confirmation = web_app.client.get(f"/projects/{project_id}/delete")
    assert confirmation.status_code == 200
    assert "画面からは元に戻せません" in confirmation.text
    assert "Managed project" in confirmation.text

    no_token = web_app.client.post(
        f"/projects/{project_id}/delete",
        data={},
        follow_redirects=False,
    )
    assert no_token.status_code == 403
    assert web_app.client.get(f"/projects/{project_id}").status_code == 200

    project_dir = web_app.settings.projects_dir / project_id
    assert project_dir.is_dir()
    deleted = web_app.client.post(
        f"/projects/{project_id}/delete",
        data={"csrf_token": token},
        follow_redirects=False,
    )
    assert deleted.status_code == 303
    assert deleted.headers["location"] == "/projects"
    assert web_app.client.get(f"/projects/{project_id}").status_code == 404
    assert not project_dir.exists()
    assert any(
        path.name.startswith(project_id) for path in (web_app.settings.data_dir / "trash").iterdir()
    )


def test_unknown_project_and_section_render_safe_not_found_pages(web_app: WebHarness) -> None:
    missing = web_app.client.get("/projects/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404
    assert "対象が見つかりません" in missing.text

    project_id = web_app.create_project()
    missing_section = web_app.client.get(f"/projects/{project_id}/sections/not-present")
    assert missing_section.status_code == 404
    assert "セクションが見つかりません" in missing_section.text
