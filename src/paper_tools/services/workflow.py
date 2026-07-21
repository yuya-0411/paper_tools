"""End-to-end project generation, advisory, rendering, and compilation workflow."""

from __future__ import annotations

import asyncio
import hashlib
import os
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings
from paper_tools.exceptions import NotFoundError, ValidationError
from paper_tools.models import (
    CompileResult as StoredCompileResult,
)
from paper_tools.models import (
    GenerationRun,
    Project,
    Section,
    SectionVersion,
)
from paper_tools.models import (
    PaperAdvice as StoredAdvice,
)
from paper_tools.providers import (
    FallbackProvider,
    MockProvider,
    OllamaProvider,
    OllamaProviderConfig,
    OpenAICompatibleConfig,
    OpenAICompatibleProvider,
    RuleBasedProvider,
    TextGenerationProvider,
)
from paper_tools.schemas import (
    AdviceCategory,
    AdviceSeverity,
    GeneratedSection,
    GenerationPurpose,
    GenerationRequest,
    GenerationResponse,
    OutlineSection,
    PaperAdvice,
    PaperLanguage,
    PaperOutline,
    PaperSpec,
)
from paper_tools.schemas.typst import CompileResult
from paper_tools.services.advisory import PaperAdvisoryService
from paper_tools.services.generation import SectionGenerationService
from paper_tools.services.planning import PaperPlanningService
from paper_tools.services.projects import ProjectService
from paper_tools.services.references import ReferenceService
from paper_tools.services.templates import TemplateService
from paper_tools.services.typst_compiler import CompileCancellation, TypstCompileService
from paper_tools.services.typst_renderer import TypstRenderingService
from paper_tools.utils.path_safety import atomic_write_bytes, resolve_within, safe_project_root

_MAX_DIRECT_SOURCE_BYTES = 4 * 1024 * 1024
_PRESET_INSTRUCTIONS = {
    "concise": "要点を保ちながら簡潔に記述する．",
    "detailed": "入力済みの根拠の範囲で説明を詳しくする．",
    "academic": "客観的で学術論文に適した表現を用いる．",
    "readable": "論理関係を明示し，読みやすさを優先する．",
    "novelty": "入力済みの新規性を明確に位置付ける．",
    "results": "入力済みの実験結果と評価条件を重視する．",
    "cautious": "過剰な主張を避け，根拠の範囲を明示する．",
    "reproducible": "再現に必要な入力済み条件と手順を明示する．",
    "review": "査読者が検証しやすい論理と根拠を示す．",
    "short": "短報向けに単一の貢献へ焦点を絞る．",
    "english-editing": "簡潔で客観的なAcademic Englishを用いる．",
}
_ADVICE_SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "introduction": ("background", "problem", "objectives", "objective"),
    "related-work": ("search-strategy", "classification", "comparison", "introduction"),
    "method": (
        "proposed-method",
        "proposed-approach",
        "system-design",
        "procedure",
        "research-plan",
        "experiments",
    ),
    "system-design": (
        "method",
        "proposed-method",
        "proposed-approach",
        "equipment",
        "research-plan",
    ),
    "control-method": (
        "method",
        "proposed-method",
        "proposed-approach",
        "procedure",
        "system-design",
    ),
    "experiments": (
        "experimental-setup",
        "conditions",
        "procedure",
        "evaluation",
        "method",
        "research-plan",
    ),
    "experimental-setup": (
        "experiments",
        "conditions",
        "procedure",
        "evaluation",
        "method",
    ),
    "evaluation-metrics": (
        "evaluation",
        "experiments",
        "experimental-setup",
        "results",
        "results-discussion",
        "analysis",
        "comparison",
    ),
    "results": (
        "results-discussion",
        "evaluation",
        "expected-results",
        "analysis",
        "comparison",
    ),
    "limitations": ("discussion", "problems", "risks", "conclusion"),
}


def _resolve_advice_target(target: str | None, available: set[str]) -> str | None:
    """Map a semantic diagnostic target to a section that exists in this template."""

    if target is None or target in available:
        return target
    return next(
        (
            candidate
            for candidate in _ADVICE_SECTION_ALIASES.get(target, ())
            if candidate in available
        ),
        None,
    )


class PaperWorkflowService:
    """Coordinate service boundaries while keeping HTTP and CLI layers thin."""

    def __init__(self, session: Session, settings: AppSettings) -> None:
        self.session = session
        self.settings = settings
        self.projects = ProjectService(session)
        self.renderer = TypstRenderingService()
        self.advisory = PaperAdvisoryService()
        self.compiler = TypstCompileService(
            settings.typst_executable,
            timeout=settings.compile_timeout_seconds,
            concurrency_limit=1,
        )

    async def generate_project(
        self,
        project_id: str,
        *,
        target_section: str | None = None,
        provider_name: str | None = None,
        instruction_override: str | None = None,
        allow_fallback: bool = True,
        selection_range: tuple[int, int] | None = None,
        expected_selection: str | None = None,
    ) -> GenerationResponse:
        project = self.projects.get_project(project_id)
        spec: PaperSpec = self.projects.to_paper_spec(project_id)
        provider = self.create_provider(provider_name, allow_fallback=allow_fallback)
        selected_presets = (
            list(project.paper_spec.selected_presets) if project.paper_spec is not None else []
        )
        preset_instruction = " ".join(
            _PRESET_INSTRUCTIONS[preset]
            for preset in selected_presets
            if preset in _PRESET_INSTRUCTIONS
        )
        section_instruction = ""
        selected_section: Section | None = None
        original_section_content: str | None = None
        selected_source: str | None = None
        if selection_range is not None and target_section is None:
            raise ValidationError("選択範囲の文章変換には対象セクションが必要です．")
        if target_section:
            selected_section = next(
                (section for section in project.sections if section.slug == target_section),
                None,
            )
            if selected_section is None:
                raise NotFoundError("再生成するセクションが見つかりません．")
            section_instruction = instruction_override or (
                selected_section.instruction or spec.section_instructions.get(target_section, "")
            )
            section_instruction = " ".join(
                part for part in (section_instruction, preset_instruction) if part
            )
            if selection_range is not None:
                start, end = selection_range
                original_section_content = selected_section.content
                if start < 0 or end <= start or end > len(original_section_content):
                    raise ValidationError("文章変換の選択範囲が不正です．")
                selected_source = original_section_content[start:end]
                if not selected_source.strip():
                    raise ValidationError("変換する文章を選択してください．")
                if expected_selection is not None and selected_source != expected_selection:
                    raise ValidationError(
                        "本文が更新されました．保存完了後に変換範囲を再選択してください．"
                    )
                section_instruction = (
                    f"{section_instruction}\n"
                    "既存本文として渡された選択範囲だけを変換し，前後の文章は出力しない．"
                ).strip()
        operation = (
            "selection-transform"
            if selection_range is not None
            else "section-regenerate"
            if target_section
            else "generate"
        )
        run = GenerationRun(
            project_id=project.id,
            operation=operation,
            provider=provider.name,
            status="generating",
            progress=10,
            message="原稿を生成しています．",
            instruction=(
                section_instruction
                if target_section
                else " ".join(
                    part for part in (spec.overall_instruction, preset_instruction) if part
                )
            ),
            started_at=datetime.now(UTC),
        )
        self.session.add(run)
        project.status = "generating"
        if project.typst_source:
            self._store_source_snapshot(
                project,
                operation=f"{operation}-source-before",
                message=(
                    "選択範囲変換前のTypstソース"
                    if selection_range is not None
                    else "セクション再生成前のTypstソース"
                    if target_section
                    else "全体生成前のTypstソース"
                ),
            )
        existing = (
            {target_section: selected_source}
            if target_section is not None and selected_source is not None
            else {section.slug: section.content for section in project.sections}
        )
        pre_generation_advice = self.refresh_advice(project.id, spec=spec)
        run.result_data = {"pre_generation_advice_ids": [item.id for item in pre_generation_advice]}
        request = GenerationRequest(
            paper_spec=(
                PaperSpec(
                    language=spec.language,
                    template_id=spec.template_id,
                    japanese_punctuation=spec.japanese_punctuation,
                    english_variant=spec.english_variant,
                )
                if selection_range is not None
                else spec
            ),
            purpose=(
                GenerationPurpose.TRANSFORM
                if selection_range is not None
                else GenerationPurpose.DRAFT
            ),
            target_section=target_section,
            instruction=run.instruction,
            existing_sections=existing,
        )
        self.session.flush()
        run_id = run.id
        # Persist the visible running state and release SQLite's write lock before
        # waiting on a provider that may take minutes or be on another machine.
        self.session.commit()
        try:
            response = await SectionGenerationService(provider).generate(request)
            project = self.projects.get_project(project_id)
            stored_run = self.session.get(GenerationRun, run_id)
            if stored_run is None:
                raise NotFoundError("生成履歴が見つかりません．")
            stored_run.status = "rendering"
            stored_run.progress = 55
            stored_run.message = "Typst原稿を構成しています．"
            if selection_range is None:
                self._store_generated_sections(project, response)
            else:
                current = next(
                    (section for section in project.sections if section.slug == target_section),
                    None,
                )
                if current is None or original_section_content is None:
                    raise NotFoundError("文章変換の対象セクションが見つかりません．")
                if current.content != original_section_content:
                    raise ValidationError(
                        "文章変換中に本文が更新されました．保存完了後に再選択してください．"
                    )
                generated = response.section(target_section or "")
                if generated is None:
                    raise ValidationError("文章変換の応答に対象セクションがありません．")
                start, end = selection_range
                self.projects.snapshot_section(
                    current,
                    operation="selection-transform-before",
                    provider=response.provider_name,
                    instruction=section_instruction,
                )
                transformed = (
                    original_section_content[:start]
                    + generated.content
                    + original_section_content[end:]
                )
                self.projects.save_section(
                    project.id,
                    current.slug,
                    content=transformed,
                    instruction=current.instruction,
                    operation="selection-transform-after",
                    provider=response.provider_name,
                )
                current.generated = True
            complete_response = response.model_copy(
                update={"sections": self._all_generated_sections(project)}
            )
            document = self.renderer.render(spec, complete_response)
            project_dir = self.project_directory(project.id)
            self.renderer.write_document(document, project_dir)
            self._write_references(project.id, project_dir)
            project.typst_source = document.source
            self.refresh_advice(project.id, spec=spec, generated=complete_response)
            project.status = "completed"
            project.updated_at = datetime.now(UTC)
            stored_run.status = "completed"
            stored_run.progress = 100
            stored_run.message = "原稿生成が完了しました．"
            stored_run.finished_at = datetime.now(UTC)
            stored_run.result_data = {
                "section_ids": [section.id for section in response.sections],
                "fallback_used": response.fallback_used,
                "warnings": response.warnings,
                "pre_generation_advice_ids": [item.id for item in pre_generation_advice],
                "suggested_figures": response.suggested_figures,
                "suggested_tables": response.suggested_tables,
                "suggested_data": response.suggested_data,
                "provenance": {
                    section.id: [segment.model_dump(mode="json") for segment in section.segments]
                    for section in response.sections
                },
                "source": document.source,
            }
            if selection_range is not None:
                stored_run.result_data["selection_range"] = list(selection_range)
            self._prune_history(project)
            self.session.flush()
            return complete_response
        except asyncio.CancelledError as exc:
            self._finish_failed_generation(project_id, run_id, exc, cancelled=True)
            raise
        except Exception as exc:
            self._finish_failed_generation(project_id, run_id, exc)
            raise

    async def translate_project(
        self,
        project_id: str,
        *,
        target_language: str,
        provider_name: str | None = None,
    ) -> GenerationResponse:
        """Translate the complete manuscript without silently using a non-LLM fallback."""

        if target_language not in {"ja", "en"}:
            raise ValidationError("翻訳先の言語が不正です．")
        project = self.projects.get_project(project_id)
        if project.language == target_language:
            raise ValidationError("原稿は既に選択した言語です．")
        if not project.sections:
            raise ValidationError("翻訳するセクションがありません．先に原稿を生成してください．")
        selected_provider = provider_name or self.settings.generation_provider
        if selected_provider in {"rule-based", "mock"}:
            raise ValidationError(
                "原稿全体の翻訳にはOllamaまたはOpenAI互換プロバイダーを設定してください．"
            )
        provider = self.create_provider(selected_provider, allow_fallback=False)
        source_spec = self.projects.to_paper_spec(project_id)
        current_manifest = TemplateService().get_template(project.template_id)
        target_template = (
            project.template_id
            if target_language in current_manifest.languages
            else "generic-en"
            if target_language == "en"
            else "generic-ja"
        )
        target_spec = source_spec.model_copy(
            update={
                "language": PaperLanguage(target_language),
                "template_id": target_template,
            }
        )
        ordered_sections = sorted(project.sections, key=lambda item: item.position)
        outline = PaperOutline(
            title=source_spec.title,
            template_id=target_template,
            language=target_language,
            sections=[
                OutlineSection(
                    id=section.slug,
                    title=section.title,
                    order=section.position,
                    instruction=section.instruction,
                )
                for section in ordered_sections
            ],
        )
        original_language = project.language
        original_sections = {section.slug: section.content for section in ordered_sections}
        instruction = (
            "原稿全体を英語へ翻訳し，数値・単位・引用キー・プレースホルダーを保持する．"
            if target_language == "en"
            else "Translate the complete manuscript into Japanese while preserving numbers, "
            "units, citation keys, and placeholders."
        )
        run = GenerationRun(
            project_id=project.id,
            operation=f"translate-{original_language}-to-{target_language}",
            provider=provider.name,
            status="generating",
            progress=10,
            message="原稿全体を翻訳しています．",
            instruction=instruction,
            started_at=datetime.now(UTC),
        )
        self.session.add(run)
        project.status = "generating"
        if project.typst_source:
            self._store_source_snapshot(
                project,
                operation="translation-source-before",
                message="原稿全体の翻訳前のTypstソース",
            )
        pre_generation_advice = self.refresh_advice(project.id, spec=source_spec)
        run.result_data = {"pre_generation_advice_ids": [item.id for item in pre_generation_advice]}
        request = GenerationRequest(
            paper_spec=target_spec,
            purpose=GenerationPurpose.TRANSLATE,
            outline=outline,
            instruction=instruction,
            existing_sections=original_sections,
        )
        self.session.flush()
        run_id = run.id
        self.session.commit()
        try:
            response = await SectionGenerationService(provider).generate(request)
            project = self.projects.get_project(project_id)
            stored_run = self.session.get(GenerationRun, run_id)
            if stored_run is None:
                raise NotFoundError("翻訳履歴が見つかりません．")
            current_sections = {section.slug: section.content for section in project.sections}
            if project.language != original_language or current_sections != original_sections:
                raise ValidationError(
                    "翻訳中に原稿が更新されました．保存完了後にもう一度実行してください．"
                )
            stored_run.status = "rendering"
            stored_run.progress = 60
            stored_run.message = "翻訳した原稿をTypstへ反映しています．"
            self._store_generated_sections(project, response)
            project.language = target_language
            project.template_id = target_template
            project.title = response.document_title or project.title
            if project.paper_spec is not None:
                project.paper_spec.keywords = response.translated_keywords
            final_spec = self.projects.to_paper_spec(project.id)
            complete_response = response.model_copy(
                update={"sections": self._all_generated_sections(project)}
            )
            document = self.renderer.render(final_spec, complete_response)
            project_dir = self.project_directory(project.id)
            self.renderer.write_document(document, project_dir)
            self._write_references(project.id, project_dir)
            project.typst_source = document.source
            self.refresh_advice(project.id, spec=final_spec, generated=complete_response)
            project.status = "completed"
            project.updated_at = datetime.now(UTC)
            stored_run.status = "completed"
            stored_run.progress = 100
            stored_run.message = "原稿全体の翻訳が完了しました．"
            stored_run.finished_at = datetime.now(UTC)
            stored_run.result_data = {
                "source_language": original_language,
                "target_language": target_language,
                "target_template": target_template,
                "translated_title": response.document_title,
                "translated_keywords": response.translated_keywords,
                "pre_generation_advice_ids": [item.id for item in pre_generation_advice],
                "provenance": {
                    section.id: [segment.model_dump(mode="json") for segment in section.segments]
                    for section in response.sections
                },
                "source": document.source,
            }
            self._prune_history(project)
            self.session.flush()
            return complete_response
        except asyncio.CancelledError as exc:
            self._finish_failed_generation(project_id, run_id, exc, cancelled=True)
            raise
        except Exception as exc:
            self._finish_failed_generation(project_id, run_id, exc)
            raise

    def regenerate_outline(self, project_id: str) -> PaperOutline:
        """Rebuild the template outline while preserving every existing body."""

        project = self.projects.get_project(project_id)
        spec: PaperSpec = self.projects.to_paper_spec(project_id)
        outline = PaperPlanningService().plan(spec)
        now = datetime.now(UTC)
        run = GenerationRun(
            project_id=project.id,
            operation="outline-regenerate",
            provider="rule-based",
            status="rendering",
            progress=40,
            message="構成を再生成しています．",
            instruction=spec.overall_instruction,
            started_at=now,
        )
        self.session.add(run)
        if project.typst_source:
            self._store_source_snapshot(
                project,
                operation="outline-regenerate-source-before",
                message="構成再生成前のTypstソース",
            )

        existing = {section.slug: section for section in project.sections}
        # Move all positions to a collision-free temporary range before assigning
        # the newly planned order; (project_id, position) is unique in SQLite.
        temporary_base = max((section.position for section in project.sections), default=-1)
        temporary_base += len(project.sections) + len(outline.sections) + 1
        for index, section in enumerate(project.sections):
            section.position = temporary_base + index
        self.session.flush()

        planned_ids: set[str] = set()
        for planned in outline.sections:
            planned_ids.add(planned.id)
            current = existing.get(planned.id)
            if current is None:
                current = self.projects.create_section(
                    project.id,
                    slug=planned.id,
                    title=planned.title,
                    position=planned.order,
                    instruction=planned.instruction,
                )
            else:
                current.title = planned.title
                current.position = planned.order
                current.instruction = planned.instruction

        # Custom or legacy sections are never discarded by an outline-only action.
        extras = sorted(
            (section for section in project.sections if section.slug not in planned_ids),
            key=lambda section: (section.position, section.slug),
        )
        for offset, section in enumerate(extras, start=len(outline.sections)):
            section.position = offset
        self.session.flush()
        self.session.expire(project, ["sections"])

        project.status = "completed"
        project.updated_at = now
        rendered = self.render_current_project(project.id)
        run.status = "completed"
        run.progress = 100
        run.message = "構成の再生成が完了しました．既存本文は保持されています．"
        run.finished_at = datetime.now(UTC)
        run.result_data = {
            "section_ids": [section.id for section in outline.sections],
            "preserved_extra_sections": [section.slug for section in extras],
            "source": rendered.typst_source,
        }
        self._prune_history(project)
        self.session.flush()
        return outline

    def refresh_advice(
        self,
        project_id: str,
        *,
        spec: PaperSpec | None = None,
        generated: GenerationResponse | None = None,
    ) -> list[StoredAdvice]:
        paper_spec = spec or self.projects.to_paper_spec(project_id)
        generated_text = (
            "\n".join(section.content for section in generated.sections)
            if generated
            else "\n".join(
                section.content for section in self.projects.get_project(project_id).sections
            )
        )
        diagnostics = self.advisory.analyze(paper_spec, generated_text)
        # Template recommendations are deterministic project diagnostics, not
        # transient provider output.  Recompute them on every refresh so a later
        # manual save/render cannot accidentally make them disappear.
        diagnostics.extend(self._suggestion_advice(paper_spec, generated))
        available_sections = set(
            self.session.scalars(select(Section.slug).where(Section.project_id == project_id))
        )
        existing: dict[tuple[str, str, str | None], StoredAdvice] = {}
        resolved_by_identity: dict[tuple[str, str], bool] = {}
        for row in self.session.scalars(
            select(StoredAdvice).where(StoredAdvice.project_id == project_id)
        ):
            identity = (row.category, row.title)
            resolved_by_identity[identity] = (
                resolved_by_identity.get(identity, False) or row.resolved
            )
            key = (row.category, row.title, row.target_section)
            duplicate = existing.get(key)
            if duplicate is None:
                existing[key] = row
            else:
                # Preserve a resolved state while collapsing any legacy duplicate.
                duplicate.resolved = duplicate.resolved or row.resolved
                self.session.delete(row)
        stored: list[StoredAdvice] = []
        for item in diagnostics:
            target_section = _resolve_advice_target(item.target_section, available_sections)
            key = (item.category.value, item.title, target_section)
            stored_row = existing.get(key)
            if stored_row is None:
                stored_row = StoredAdvice(
                    project_id=project_id,
                    category=item.category.value,
                    severity=item.severity.value,
                    title=item.title,
                    description=item.description,
                    reason=item.reason,
                    target_section=target_section,
                    suggested_action=item.suggested_action,
                    resolved=resolved_by_identity.get((item.category.value, item.title), False),
                )
                self.session.add(stored_row)
            else:
                del existing[key]
                stored_row.severity = item.severity.value
                stored_row.description = item.description
                stored_row.reason = item.reason
                stored_row.suggested_action = item.suggested_action
            stored.append(stored_row)
        for stale in existing.values():
            self.session.delete(stale)
        self.session.flush()
        return stored

    def render_current_project(self, project_id: str) -> Project:
        """Synchronise edited sections, project files, source, and advice.

        Manual section edits are database-first.  This method deliberately rebuilds
        package-owned Typst instead of splicing untrusted text into an old source file.
        """

        project = self.projects.get_project(project_id)
        if project.typst_source:
            self._store_source_snapshot(
                project,
                operation="render-source-before",
                message="自動再構成前のTypstソース",
            )
        spec: PaperSpec = self.projects.to_paper_spec(project_id)
        ordered = sorted(project.sections, key=lambda item: item.position)
        outline = PaperOutline(
            title=spec.title,
            template_id=project.template_id,
            language=project.language,
            sections=[
                OutlineSection(
                    id=section.slug,
                    title=section.title,
                    order=section.position,
                    instruction=section.instruction,
                )
                for section in ordered
            ],
        )
        response = GenerationResponse(
            outline=outline,
            sections=[
                GeneratedSection(
                    id=section.slug,
                    title=section.title,
                    content=section.content,
                    instruction_applied=section.instruction,
                )
                for section in ordered
            ],
            provider_name="manual",
        )
        document = self.renderer.render(spec, response)
        project_dir = self.project_directory(project.id)
        self.renderer.write_document(document, project_dir)
        self._write_references(project.id, project_dir)
        project.typst_source = document.source
        project.updated_at = datetime.now(UTC)
        self.refresh_advice(project.id, spec=spec, generated=response)
        self._prune_history(project)
        self.session.flush()
        return project

    def resolve_advice(self, project_id: str, advice_id: str) -> StoredAdvice:
        advice = self.session.get(StoredAdvice, advice_id)
        if advice is None or advice.project_id != project_id:
            raise NotFoundError("助言が見つかりません．")
        advice.resolved = True
        self.session.flush()
        return advice

    def mark_generation_timeout(self, project_id: str, *, timeout_seconds: float) -> None:
        """Persist the timeout that an outer in-process job manager observed."""

        project = self.projects.get_project(project_id, aggregate=False)
        run = self.session.scalar(
            select(GenerationRun)
            .where(
                GenerationRun.project_id == project_id,
                GenerationRun.status.in_(("planning", "generating", "rendering", "cancelled")),
            )
            .order_by(GenerationRun.created_at.desc(), GenerationRun.id.desc())
            .limit(1)
        )
        project.status = "failed"
        if run is not None:
            run.status = "failed"
            run.message = "生成処理がタイムアウトしました．"
            run.error_message = f"timeout after {timeout_seconds:g} seconds"
            run.finished_at = datetime.now(UTC)
        self.session.flush()

    def save_typst_source(self, project_id: str, source: str) -> Project:
        encoded = source.encode("utf-8")
        if len(encoded) > _MAX_DIRECT_SOURCE_BYTES:
            raise ValidationError("Typstソースがサイズ上限を超えています．")
        if "\x00" in source:
            raise ValidationError("Typstソースに使用できない文字が含まれています．")
        project = self.projects.get_project(project_id, aggregate=False)
        if project.typst_source == source:
            return project
        self._store_source_snapshot(
            project,
            operation="source-snapshot",
            message="Typstソース編集前の版",
        )
        project.typst_source = source
        project.updated_at = datetime.now(UTC)
        project_dir = self.project_directory(project.id)
        project_dir.mkdir(parents=True, exist_ok=True)
        main_path = resolve_within(project_dir, "main.typ")
        atomic_write_bytes(main_path, source.encode("utf-8"))
        self._store_source_snapshot(
            project,
            operation="source-manual-save",
            message="Typstソース手動保存版",
        )
        self._prune_history(project)
        self.session.flush()
        return project

    def restore_source_snapshot(self, project_id: str, run_id: str) -> Project:
        run = self.session.get(GenerationRun, run_id)
        if run is None or run.project_id != project_id:
            raise NotFoundError("復元するTypstソースが見つかりません．")
        source = run.result_data.get("source")
        if not isinstance(source, str):
            raise ValidationError("保存済みソースの形式が不正です．")
        return self.save_typst_source(project_id, source)

    def compile_project(
        self,
        project_id: str,
        *,
        cancellation: CompileCancellation | None = None,
    ) -> CompileResult:
        project = self.projects.get_project(project_id, aggregate=False)
        project_dir = self.project_directory(project.id)
        main_path = resolve_within(project_dir, "main.typ")
        output_path = resolve_within(project_dir, "output/paper.pdf")
        if project.typst_source and not main_path.is_file():
            project_dir.mkdir(parents=True, exist_ok=True)
            main_path = resolve_within(project_dir, "main.typ")
            atomic_write_bytes(main_path, project.typst_source.encode("utf-8"))
        if cancellation is None:
            result = self.compiler.compile(main_path, output_path, project_root=project_dir)
        else:
            result = self.compiler.compile(
                main_path,
                output_path,
                project_root=project_dir,
                cancellation=cancellation,
            )
        stored = StoredCompileResult(
            project_id=project.id,
            status=result.status.value,
            success=result.success,
            command=result.command,
            exit_code=result.exit_code,
            stdout=result.stdout[-200_000:],
            stderr=result.stderr[-200_000:],
            errors=result.errors,
            output_path="output/paper.pdf" if result.success else None,
            duration_ms=result.duration_ms,
        )
        self.session.add(stored)
        if result.success:
            project.pdf_relative_path = "output/paper.pdf"
            # PDF URLs use this timestamp as their cache revision.  A successful
            # compile must therefore advance it even when the Typst source did not
            # change immediately before compilation.
            project.updated_at = datetime.now(UTC)
        self.session.flush()
        return result

    def create_provider(
        self,
        name: str | None = None,
        *,
        allow_fallback: bool = True,
    ) -> TextGenerationProvider:
        selected = name or self.settings.generation_provider
        fallback = RuleBasedProvider()
        if selected == "rule-based":
            return fallback
        if selected == "mock":
            return MockProvider()
        if selected == "ollama":
            primary: TextGenerationProvider = OllamaProvider(
                OllamaProviderConfig(
                    base_url=self.settings.ollama_url,
                    model=self.settings.ollama_model or "llama3.2",
                    timeout=self.settings.generation_timeout_seconds,
                    temperature=self.settings.generation_temperature,
                )
            )
            return FallbackProvider(primary, fallback) if allow_fallback else primary
        if selected == "openai-compatible":
            credentials = dict(os.environ)
            if self.settings.openai_api_key is not None:
                credentials["PAPER_TOOLS_OPENAI_API_KEY"] = (
                    self.settings.openai_api_key.get_secret_value()
                )
            primary = OpenAICompatibleProvider(
                OpenAICompatibleConfig(
                    base_url=self.settings.openai_compatible_base_url,
                    model=self.settings.openai_compatible_model,
                    api_key_env="PAPER_TOOLS_OPENAI_API_KEY",
                    timeout=self.settings.generation_timeout_seconds,
                    temperature=self.settings.generation_temperature,
                    max_output_tokens=self.settings.maximum_output_tokens,
                ),
                environment=credentials,
            )
            return FallbackProvider(primary, fallback) if allow_fallback else primary
        raise ValidationError(f"未対応の生成プロバイダーです: {selected}")

    def project_directory(self, project_id: str) -> Path:
        return safe_project_root(self.settings.projects_dir, project_id)

    def _store_generated_sections(
        self,
        project: Project,
        response: GenerationResponse,
    ) -> None:
        by_slug = {section.slug: section for section in project.sections}
        outline_positions = {section.id: section.order for section in response.outline.sections}
        for generated in response.sections:
            current = by_slug.get(generated.id)
            if current is None:
                current = self.projects.create_section(
                    project.id,
                    slug=generated.id,
                    title=generated.title,
                    position=outline_positions[generated.id],
                    content=generated.content,
                    instruction=generated.instruction_applied,
                    generated=True,
                )
                by_slug[current.slug] = current
            else:
                self.projects.snapshot_section(
                    current,
                    operation="generation-before",
                    provider=response.provider_name,
                    instruction=generated.instruction_applied,
                )
                self.projects.save_section(
                    project.id,
                    current.slug,
                    content=generated.content,
                    instruction=generated.instruction_applied,
                    operation="generation-after",
                    provider=response.provider_name,
                )
                current.title = generated.title
                current.generated = True
        self.session.flush()

    def _finish_failed_generation(
        self,
        project_id: str,
        run_id: str,
        error: BaseException,
        *,
        cancelled: bool = False,
    ) -> None:
        """Roll back partial output, then persist one terminal run in its own transaction."""

        self.session.rollback()
        project = self.projects.get_project(project_id, aggregate=False)
        run = self.session.get(GenerationRun, run_id)
        project.status = "cancelled" if cancelled else "failed"
        if run is not None:
            run.status = project.status
            run.error_message = str(error)[:4000]
            run.message = "生成処理を取り消しました．" if cancelled else "原稿生成に失敗しました．"
            run.finished_at = datetime.now(UTC)
        self.session.commit()

    def _store_source_snapshot(
        self,
        project: Project,
        *,
        operation: str,
        message: str,
    ) -> GenerationRun:
        latest = self.session.scalar(
            select(GenerationRun)
            .where(GenerationRun.project_id == project.id)
            .order_by(GenerationRun.created_at.desc(), GenerationRun.id.desc())
            .limit(1)
        )
        if latest is not None and latest.result_data.get("source") == project.typst_source:
            return latest
        run = GenerationRun(
            project_id=project.id,
            operation=operation,
            provider="manual",
            status="completed",
            progress=100,
            message=message,
            result_data={"source": project.typst_source},
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        )
        self.session.add(run)
        self.session.flush()
        return run

    def _suggestion_advice(
        self,
        spec: PaperSpec,
        generated: GenerationResponse | None,
    ) -> list[PaperAdvice]:
        manifest = TemplateService().get_template(spec.template_id)
        existing_asset_text = " ".join(
            f"{asset.name} {asset.description} {asset.purpose}" for asset in spec.assets
        ).lower()

        def missing(recommended: list[str]) -> list[str]:
            return [item for item in recommended if item.lower() not in existing_asset_text]

        def combined(provider_items: list[str], template_items: list[str]) -> list[str]:
            # Preserve the provider order while including every still-missing
            # manifest recommendation exactly once.
            return list(dict.fromkeys([*provider_items, *missing(template_items)]))

        labels = (
            {
                AdviceCategory.FIGURE: "テンプレート推奨図",
                AdviceCategory.TABLE: "テンプレート推奨表",
                AdviceCategory.DATA: "テンプレート推奨データ",
            }
            if spec.language.value == "ja"
            else {
                AdviceCategory.FIGURE: "Recommended figure",
                AdviceCategory.TABLE: "Recommended table",
                AdviceCategory.DATA: "Recommended data",
            }
        )
        provider_figures = generated.suggested_figures if generated is not None else []
        provider_tables = generated.suggested_tables if generated is not None else []
        provider_data = generated.suggested_data if generated is not None else []
        groups = (
            (
                AdviceCategory.FIGURE,
                combined(provider_figures, manifest.recommended_figures),
            ),
            (
                AdviceCategory.TABLE,
                combined(provider_tables, manifest.recommended_tables),
            ),
            (
                AdviceCategory.DATA,
                combined(provider_data, manifest.recommended_data),
            ),
        )
        advice: list[PaperAdvice] = []
        for category, items in groups:
            for item in items:
                digest = hashlib.sha256(
                    f"{spec.template_id}:{category.value}:{item}".encode()
                ).hexdigest()[:16]
                label = labels[category]
                advice.append(
                    PaperAdvice(
                        id=f"template.{category.value}.{digest}",
                        category=category,
                        severity=AdviceSeverity.RECOMMENDED,
                        title=f"{label}: {item}",
                        description=f"選択テンプレートでは「{item}」の追加を推奨しています．",
                        reason="テンプレートの推奨項目が登録済み資料から確認できません．",
                        suggested_action="必要性を確認し，根拠と出典を添えて登録してください．",
                    )
                )
        return advice

    def _write_references(self, project_id: str, project_dir: Path) -> None:
        references = ReferenceService(self.session).export_hayagriva_yaml(project_id)
        target = resolve_within(project_dir, "references.yml")
        atomic_write_bytes(target, references.encode("utf-8"))

    def _prune_history(self, project: Project) -> None:
        keep = self.settings.backup_count
        for section in project.sections:
            stale_versions = self.session.scalars(
                select(SectionVersion.id)
                .where(SectionVersion.section_id == section.id)
                .order_by(SectionVersion.created_at.desc(), SectionVersion.id.desc())
                .offset(keep)
            ).all()
            if stale_versions:
                self.session.execute(
                    delete(SectionVersion).where(SectionVersion.id.in_(stale_versions))
                )
        stale_runs = self.session.scalars(
            select(GenerationRun.id)
            .where(GenerationRun.project_id == project.id)
            .order_by(GenerationRun.created_at.desc(), GenerationRun.id.desc())
            .offset(keep)
        ).all()
        if stale_runs:
            self.session.execute(delete(GenerationRun).where(GenerationRun.id.in_(stale_runs)))

    @staticmethod
    def _all_generated_sections(project: Project) -> list[GeneratedSection]:
        return [
            GeneratedSection(
                id=section.slug,
                title=section.title,
                content=section.content,
                instruction_applied=section.instruction,
            )
            for section in sorted(project.sections, key=lambda item: item.position)
        ]


__all__ = ["PaperWorkflowService"]
