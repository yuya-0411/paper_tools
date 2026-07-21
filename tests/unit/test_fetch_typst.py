from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from scripts import fetch_typst


def _archive_bytes(*, unsafe: bool = False) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        if unsafe:
            archive.writestr("../outside.txt", "unsafe")
        else:
            archive.writestr("typst/typst.exe", b"typst-binary")
            archive.writestr("typst/LICENSE", "Apache License")
            archive.writestr("typst/README.md", "Typst")
    return output.getvalue()


def test_safe_extract_rejects_parent_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    archive.write_bytes(_archive_bytes(unsafe=True))

    with pytest.raises(ValueError, match="Unsafe"):
        fetch_typst._safe_extract(archive, tmp_path / "out")

    assert not (tmp_path / "outside.txt").exists()


def test_fetch_typst_verifies_and_reuses_cached_binary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _archive_bytes()
    monkeypatch.setattr(
        fetch_typst,
        "TYPST_ARCHIVE_SHA256",
        hashlib.sha256(payload).hexdigest(),
    )
    calls = 0

    def open_archive(*_args: object, **_kwargs: object) -> io.BytesIO:
        nonlocal calls
        calls += 1
        return io.BytesIO(payload)

    monkeypatch.setattr(fetch_typst.urllib.request, "urlopen", open_archive)
    destination = tmp_path / "vendor" / "typst"

    executable = fetch_typst.fetch_typst(destination)
    cached = fetch_typst.fetch_typst(destination)

    assert executable == cached
    assert executable.read_bytes() == b"typst-binary"
    assert (destination / "LICENSE").read_text(encoding="utf-8") == "Apache License"
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["typst_sha256"] == hashlib.sha256(b"typst-binary").hexdigest()
    assert calls == 1


def test_fetch_typst_refuses_modified_existing_cache(tmp_path: Path) -> None:
    destination = tmp_path / "typst"
    destination.mkdir()
    (destination / "typst.exe").write_bytes(b"modified")

    with pytest.raises(RuntimeError, match="incomplete or modified"):
        fetch_typst.fetch_typst(destination)
