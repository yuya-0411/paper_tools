"""Locate read-only tools and assets shipped with a frozen desktop build."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def is_frozen_app() -> bool:
    """Return whether the process is running from a freezer such as PyInstaller."""

    return bool(getattr(sys, "frozen", False))


def bundled_typst_path(
    *,
    package_root: Path | None = None,
    executable_name: str | None = None,
) -> Path | None:
    """Return the bundled Typst executable when the distribution contains one."""

    root = package_root or Path(__file__).resolve().parent
    name = executable_name or ("typst.exe" if os.name == "nt" else "typst")
    candidate = root / "vendor" / "typst" / name
    return candidate if candidate.is_file() else None


def default_typst_executable() -> str:
    """Prefer the distribution-owned Typst and otherwise retain PATH discovery."""

    bundled = bundled_typst_path()
    return str(bundled) if bundled is not None else "typst"


__all__ = ["bundled_typst_path", "default_typst_executable", "is_frozen_app"]
