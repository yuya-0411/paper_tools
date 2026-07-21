from __future__ import annotations

from pathlib import Path

import pytest

from paper_tools import bundled


def test_bundled_typst_path_uses_package_relative_vendor_directory(tmp_path: Path) -> None:
    executable = tmp_path / "vendor" / "typst" / "typst.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"typst")

    assert (
        bundled.bundled_typst_path(
            package_root=tmp_path,
            executable_name="typst.exe",
        )
        == executable
    )


def test_bundled_typst_path_returns_none_when_distribution_has_no_binary(
    tmp_path: Path,
) -> None:
    assert bundled.bundled_typst_path(package_root=tmp_path, executable_name="typst.exe") is None


def test_default_typst_executable_falls_back_to_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(bundled, "bundled_typst_path", lambda: None)

    assert bundled.default_typst_executable() == "typst"
