"""Reference CRUD plus deterministic BibTeX/Hayagriva interchange."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import yaml
from sqlalchemy.orm import Session

from paper_tools.exceptions import ConflictError, ValidationError
from paper_tools.models import Reference
from paper_tools.repositories import ProjectRepository, ReferenceRepository

_CITATION_KEY_RE = re.compile(r"^[^\s{},=]+$")


@dataclass(frozen=True, slots=True)
class ReferenceImportResult:
    created: tuple[Reference, ...]
    duplicate_keys: tuple[str, ...]
    errors: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ReferenceUsage:
    unused_keys: tuple[str, ...]
    missing_keys: tuple[str, ...]


class ReferenceService:
    def __init__(self, session: Session) -> None:
        self.session = session
        self.projects = ProjectRepository(session)
        self.references = ReferenceRepository(session)

    def create_reference(
        self,
        project_id: str,
        *,
        citation_key: str,
        title: str,
        authors: Iterable[str] = (),
        year: int | None = None,
        venue: str = "",
        volume: str = "",
        issue: str = "",
        pages: str = "",
        doi: str = "",
        url: str = "",
        note: str = "",
        entry_type: str = "article",
    ) -> Reference:
        self.projects.get_required(project_id)
        key = self._validate_key(citation_key)
        clean_title = title.strip()
        if not clean_title:
            raise ValidationError("参考文献のタイトルを入力してください．")
        if self.references.by_key(project_id, key) is not None:
            raise ConflictError(f"引用キー「{key}」は既に登録されています．")
        normalized_year = self._normalize_year(year)
        reference = Reference(
            project_id=project_id,
            citation_key=key,
            entry_type=entry_type.strip().lower() or "article",
            title=clean_title,
            authors=[author.strip() for author in authors if author.strip()],
            year=normalized_year,
            venue=venue.strip(),
            volume=volume.strip(),
            issue=issue.strip(),
            pages=pages.strip(),
            doi=doi.strip(),
            url=url.strip(),
            note=note.strip(),
        )
        return self.references.add(reference)

    def list_references(self, project_id: str) -> Sequence[Reference]:
        self.projects.get_required(project_id)
        return self.references.for_project(project_id)

    def update_reference(
        self,
        project_id: str,
        reference_id: str,
        values: Mapping[str, Any],
    ) -> Reference:
        reference = self.references.get_for_project(project_id, reference_id)
        allowed = {
            "citation_key",
            "entry_type",
            "title",
            "authors",
            "year",
            "venue",
            "volume",
            "issue",
            "pages",
            "doi",
            "url",
            "note",
        }
        unknown = set(values) - allowed
        if unknown:
            raise ValidationError(f"未対応の参考文献情報です: {', '.join(sorted(unknown))}")
        if "citation_key" in values:
            key = self._validate_key(str(values["citation_key"]))
            duplicate = self.references.by_key(project_id, key)
            if duplicate is not None and duplicate.id != reference.id:
                raise ConflictError(f"引用キー「{key}」は既に登録されています．")
            reference.citation_key = key
        if "title" in values:
            title = str(values["title"]).strip()
            if not title:
                raise ValidationError("参考文献のタイトルを入力してください．")
            reference.title = title
        if "authors" in values:
            raw_authors = values["authors"]
            if isinstance(raw_authors, str):
                reference.authors = [
                    author.strip() for author in raw_authors.split(" and ") if author.strip()
                ]
            elif isinstance(raw_authors, Iterable):
                reference.authors = [
                    str(author).strip() for author in raw_authors if str(author).strip()
                ]
            else:
                raise ValidationError("著者情報の形式が不正です．")
        if "year" in values:
            reference.year = self._normalize_year(values["year"])
        for field in {
            "entry_type",
            "venue",
            "volume",
            "issue",
            "pages",
            "doi",
            "url",
            "note",
        }:
            if field in values:
                setattr(reference, field, str(values[field]).strip())
        self.session.flush()
        return reference

    def delete_reference(self, project_id: str, reference_id: str) -> None:
        reference = self.references.get_for_project(project_id, reference_id)
        self.references.delete(reference)

    def import_bibtex(self, project_id: str, bibtex: str) -> ReferenceImportResult:
        self.projects.get_required(project_id)
        entries = parse_bibtex(bibtex)
        seen = {
            reference.citation_key.casefold()
            for reference in self.references.for_project(project_id)
        }
        batch_seen: set[str] = set()
        created: list[Reference] = []
        duplicates: list[str] = []
        errors: list[str] = []
        for entry in entries:
            key = entry.get("citation_key", "").strip()
            folded = key.casefold()
            if not key:
                errors.append("引用キーのないBibTeXエントリを読み飛ばしました．")
                continue
            if folded in seen or folded in batch_seen:
                duplicates.append(key)
                continue
            title = entry.get("title", "").strip()
            if not title:
                errors.append(f"{key}: title がないため読み飛ばしました．")
                continue
            year_value: int | None = None
            raw_year = entry.get("year", "").strip()
            if raw_year:
                if not raw_year.isdigit() or not 1000 <= int(raw_year) <= 9999:
                    errors.append(f"{key}: year の形式が不正です．")
                    continue
                year_value = int(raw_year)
            try:
                reference = self.create_reference(
                    project_id,
                    citation_key=key,
                    title=title,
                    authors=_split_bibtex_authors(entry.get("author", "")),
                    year=year_value,
                    venue=entry.get("journal", entry.get("booktitle", "")),
                    volume=entry.get("volume", ""),
                    issue=entry.get("number", ""),
                    pages=entry.get("pages", ""),
                    doi=entry.get("doi", ""),
                    url=entry.get("url", ""),
                    note=entry.get("note", ""),
                    entry_type=entry.get("entry_type", "article"),
                )
            except (ConflictError, ValidationError) as exc:
                errors.append(f"{key}: {exc}")
                continue
            batch_seen.add(folded)
            created.append(reference)
        return ReferenceImportResult(tuple(created), tuple(duplicates), tuple(errors))

    def export_bibtex(self, project_id: str) -> str:
        references = self.list_references(project_id)
        blocks: list[str] = []
        for reference in references:
            fields: list[tuple[str, str]] = [
                ("title", reference.title),
                ("author", " and ".join(reference.authors)),
                ("year", str(reference.year) if reference.year is not None else ""),
                (
                    "booktitle"
                    if reference.entry_type in {"inproceedings", "conference"}
                    else "journal",
                    reference.venue,
                ),
                ("volume", reference.volume),
                ("number", reference.issue),
                ("pages", reference.pages),
                ("doi", reference.doi),
                ("url", reference.url),
                ("note", reference.note),
            ]
            rendered_fields = [
                f"  {name} = {{{_escape_bibtex(value)}}}" for name, value in fields if value
            ]
            body = ",\n".join(rendered_fields)
            blocks.append(f"@{reference.entry_type}{{{reference.citation_key},\n{body}\n}}")
        return "\n\n".join(blocks) + ("\n" if blocks else "")

    def export_hayagriva_yaml(self, project_id: str) -> str:
        documents: dict[str, dict[str, Any]] = {}
        for reference in self.list_references(project_id):
            entry: dict[str, Any] = {
                "type": _hayagriva_type(reference.entry_type),
                "title": reference.title,
            }
            if reference.authors:
                entry["author"] = list(reference.authors)
            if reference.year is not None:
                entry["date"] = reference.year
            if reference.venue:
                parent: dict[str, Any] = {"title": reference.venue}
                if reference.volume:
                    parent["volume"] = reference.volume
                if reference.issue:
                    parent["issue"] = reference.issue
                entry["parent"] = parent
            if reference.pages:
                entry["page-range"] = reference.pages.replace("--", "-")
            if reference.doi:
                entry["serial-number"] = {"doi": reference.doi}
            if reference.url:
                entry["url"] = reference.url
            if reference.note:
                entry["note"] = reference.note
            documents[reference.citation_key] = entry
        return yaml.safe_dump(
            documents,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        )

    # Friendly short alias used by exporters/routes.
    export_yaml = export_hayagriva_yaml

    def analyze_usage(self, project_id: str, used_keys: Iterable[str]) -> ReferenceUsage:
        stored = {
            reference.citation_key.casefold(): reference.citation_key
            for reference in self.list_references(project_id)
        }
        used = {key.strip().casefold(): key.strip() for key in used_keys if key.strip()}
        unused = tuple(sorted(stored[key] for key in stored.keys() - used.keys()))
        missing = tuple(sorted(used[key] for key in used.keys() - stored.keys()))
        return ReferenceUsage(unused_keys=unused, missing_keys=missing)

    @staticmethod
    def _validate_key(value: str) -> str:
        key = value.strip()
        if not key or not _CITATION_KEY_RE.fullmatch(key):
            raise ValidationError("引用キーに空白，波括弧，カンマ，等号は使用できません．")
        return key

    @staticmethod
    def _normalize_year(value: Any) -> int | None:
        if value in (None, ""):
            return None
        try:
            year = int(value)
        except (TypeError, ValueError) as exc:
            raise ValidationError("年は4桁の数値で指定してください．") from exc
        if not 1000 <= year <= 9999:
            raise ValidationError("年は1000から9999で指定してください．")
        return year


def parse_bibtex(source: str) -> list[dict[str, str]]:
    """Parse common BibTeX entries without evaluating string macros or commands."""

    entries: list[dict[str, str]] = []
    index = 0
    while True:
        at = source.find("@", index)
        if at < 0:
            break
        match = re.match(r"@\s*([A-Za-z]+)\s*([({])", source[at:])
        if match is None:
            raise ValidationError("BibTeXエントリの開始形式が不正です．")
        entry_type = match.group(1).lower()
        opener = match.group(2)
        closer = "}" if opener == "{" else ")"
        body_start = at + match.end()
        body_end = _find_matching_delimiter(source, body_start, opener, closer)
        if body_end is None:
            raise ValidationError("BibTeXエントリの括弧が閉じられていません．")
        body = source[body_start:body_end].strip()
        index = body_end + 1
        if entry_type in {"comment", "preamble", "string"}:
            continue
        head = _split_top_level(body, maxsplit=1)
        if len(head) != 2:
            raise ValidationError("BibTeXエントリに引用キーまたはフィールドがありません．")
        entry: dict[str, str] = {
            "entry_type": entry_type,
            "citation_key": head[0].strip(),
        }
        for field_text in _split_top_level(head[1]):
            if not field_text.strip():
                continue
            name, separator, raw_value = field_text.partition("=")
            if not separator or not name.strip():
                raise ValidationError("BibTeXフィールドの形式が不正です．")
            entry[name.strip().lower()] = _unwrap_bibtex_value(raw_value.strip())
        entries.append(entry)
    return entries


def _find_matching_delimiter(
    source: str,
    start: int,
    opener: str,
    closer: str,
) -> int | None:
    depth = 1
    quoted = False
    escaped = False
    for index in range(start, len(source)):
        character = source[index]
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if character == opener:
            depth += 1
        elif character == closer:
            depth -= 1
            if depth == 0:
                return index
    return None


def _split_top_level(value: str, *, maxsplit: int = -1) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quoted = False
    escaped = False
    splits = 0
    for index, character in enumerate(value):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == '"':
            quoted = not quoted
        elif not quoted:
            if character in "{(":
                depth += 1
            elif character in "})" and depth:
                depth -= 1
            elif character == "," and depth == 0 and (maxsplit < 0 or splits < maxsplit):
                parts.append(value[start:index])
                start = index + 1
                splits += 1
    parts.append(value[start:])
    return parts


def _unwrap_bibtex_value(value: str) -> str:
    result = value.strip()
    if len(result) >= 2 and (
        (result[0] == "{" and result[-1] == "}") or (result[0] == '"' and result[-1] == '"')
    ):
        result = result[1:-1]
    return re.sub(r"\s+", " ", result).strip()


def _split_bibtex_authors(value: str) -> list[str]:
    return [author.strip() for author in re.split(r"\s+and\s+", value) if author.strip()]


def _escape_bibtex(value: str) -> str:
    return value.replace("\r", " ").replace("\n", " ").replace("{", r"\{").replace("}", r"\}")


def _hayagriva_type(entry_type: str) -> str:
    return {
        "article": "article",
        "book": "book",
        "inbook": "chapter",
        "incollection": "chapter",
        "conference": "article",
        "inproceedings": "article",
        "phdthesis": "thesis",
        "mastersthesis": "thesis",
        "techreport": "report",
    }.get(entry_type.casefold(), "misc")


__all__ = [
    "ReferenceImportResult",
    "ReferenceService",
    "ReferenceUsage",
    "parse_bibtex",
]
