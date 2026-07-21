"""Central path validation for project files, uploads, and ZIP members."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path, PurePosixPath
from uuid import uuid4

from paper_tools.exceptions import ValidationError

_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400


def _is_path_redirect(path: Path) -> bool:
    """Return whether an existing entry can redirect pathname traversal.

    ``Path.is_symlink()`` is insufficient on Windows because directory junctions
    and other name-surrogate reparse points are not necessarily reported as
    symbolic links.  ``lstat`` also lets us detect dangling symbolic links, for
    which ``Path.exists()`` is false.
    """

    try:
        metadata = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return False
    return (
        stat.S_ISLNK(metadata.st_mode)
        or bool(getattr(metadata, "st_reparse_tag", 0))
        or bool(getattr(metadata, "st_file_attributes", 0) & _WINDOWS_REPARSE_POINT_ATTRIBUTE)
    )


def _reject_path_redirects(root: Path, relative_parts: tuple[str, ...]) -> None:
    """Reject every existing lexical component below a trusted root."""

    current = root
    for part in relative_parts:
        current /= part
        if _is_path_redirect(current):
            raise ValidationError("シンボリックリンクや再解析ポイントは使用できません．")


def validate_project_id(project_id: str) -> str:
    """Reject identifiers that could alter the project directory boundary."""

    if not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValidationError("プロジェクトIDの形式が不正です．")
    return project_id


def normalize_relative_path(value: str | Path) -> str:
    """Normalize a user/database path to a safe portable POSIX relative path."""

    raw = str(value).replace("\\", "/")
    if not raw or "\x00" in raw:
        raise ValidationError("空または不正なファイルパスです．")
    candidate = PurePosixPath(raw)
    parts = candidate.parts
    if candidate.is_absolute() or not parts:
        raise ValidationError("絶対パスは使用できません．")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValidationError("親ディレクトリを参照するパスは使用できません．")
    if ":" in parts[0]:
        raise ValidationError("ドライブ指定を含むパスは使用できません．")
    return candidate.as_posix()


def resolve_within(
    root: Path,
    relative_path: str | Path,
    *,
    must_exist: bool = False,
    reject_symlinks: bool = True,
) -> Path:
    """Resolve a relative path and prove that it stays below ``root``."""

    normalized = normalize_relative_path(relative_path)
    root_candidate = root.expanduser()
    if reject_symlinks and _is_path_redirect(root_candidate):
        raise ValidationError("シンボリックリンクや再解析ポイントは使用できません．")
    root_resolved = root_candidate.resolve(strict=False)
    relative_parts = PurePosixPath(normalized).parts
    unresolved_target = root_resolved.joinpath(*relative_parts)

    # Inspect the lexical path before resolving it.  Resolving first erases a
    # symlink/junction that points elsewhere *within* the root and therefore made
    # the old post-resolution walk incapable of detecting that redirect.
    if reject_symlinks:
        _reject_path_redirects(root_resolved, relative_parts)

    target = unresolved_target.resolve(strict=must_exist)
    try:
        target.relative_to(root_resolved)
    except ValueError as exc:
        raise ValidationError("プロジェクト外のパスは使用できません．") from exc

    # Recheck after resolution to narrow the check/use window and to catch a
    # component that was introduced while ``resolve`` was running.
    if reject_symlinks:
        if _is_path_redirect(root_candidate):
            raise ValidationError("シンボリックリンクや再解析ポイントは使用できません．")
        _reject_path_redirects(root_resolved, relative_parts)
    return target


def safe_project_root(projects_dir: Path, project_id: str, *, create: bool = False) -> Path:
    validate_project_id(project_id)
    project_root = resolve_within(projects_dir, project_id, reject_symlinks=True)
    if create:
        project_root.mkdir(parents=True, exist_ok=True)
        # ``mkdir(exist_ok=True)`` accepts a directory symlink/junction.  Verify
        # the resulting entry before returning it to a writer.
        project_root = resolve_within(projects_dir, project_id, reject_symlinks=True)
    return project_root


def sanitize_uploaded_filename(filename: str) -> str:
    """Keep only a harmless display basename; storage never uses this name."""

    if "\x00" in filename:
        raise ValidationError("ファイル名に不正な文字が含まれています．")
    basename = PurePosixPath(filename.replace("\\", "/")).name.strip()
    if basename in {"", ".", ".."}:
        raise ValidationError("ファイル名が空です．")
    sanitized = "".join("_" if ord(character) < 32 else character for character in basename)
    return sanitized[:255]


def safe_zip_arcname(value: str | Path) -> str:
    """Return a traversal-free ZIP member name."""

    return normalize_relative_path(value)


def read_bytes_bounded(path: Path, *, maximum_bytes: int) -> bytes:
    """Read a regular non-symlink file while enforcing a hard size bound."""

    if maximum_bytes < 0:
        raise ValueError("maximum_bytes must be non-negative")
    if path.is_symlink() or not path.is_file():
        raise ValidationError("通常ファイルだけを読み込めます．")
    size = path.stat().st_size
    if size > maximum_bytes:
        raise ValidationError("ファイルサイズが上限を超えています．")
    with path.open("rb") as stream:
        data = stream.read(maximum_bytes + 1)
    if len(data) > maximum_bytes:
        raise ValidationError("ファイルサイズが上限を超えています．")
    return data


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically replace an application-owned file in its existing directory."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


__all__ = [
    "atomic_write_bytes",
    "normalize_relative_path",
    "read_bytes_bounded",
    "resolve_within",
    "safe_project_root",
    "safe_zip_arcname",
    "sanitize_uploaded_filename",
    "validate_project_id",
]
