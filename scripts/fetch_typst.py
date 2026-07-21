"""Download and verify the official Typst binary used by desktop builds."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TYPST_VERSION = "0.15.1"
TYPST_ARCHIVE_NAME = "typst-x86_64-pc-windows-msvc.zip"
TYPST_ARCHIVE_SHA256 = "19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736"
TYPST_DOWNLOAD_URL = (
    f"https://github.com/typst/typst/releases/download/v{TYPST_VERSION}/{TYPST_ARCHIVE_NAME}"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            parts = PurePosixPath(member.filename).parts
            if not parts or any(part in {"", ".", ".."} for part in parts):
                raise ValueError(f"Unsafe Typst archive member: {member.filename}")
            target = destination.joinpath(*parts)
            resolved = target.resolve(strict=False)
            if root != resolved and root not in resolved.parents:
                raise ValueError(f"Unsafe Typst archive member: {member.filename}")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _existing_install_is_valid(destination: Path) -> bool:
    manifest_path = destination / "manifest.json"
    executable = destination / "typst.exe"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return (
            manifest.get("version") == TYPST_VERSION
            and manifest.get("archive_sha256") == TYPST_ARCHIVE_SHA256
            and manifest.get("typst_sha256") == sha256_file(executable)
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False


def fetch_typst(destination: Path) -> Path:
    """Populate *destination* with a verified Typst executable and license."""

    if _existing_install_is_valid(destination):
        return destination / "typst.exe"
    if destination.exists():
        raise RuntimeError(
            f"Existing Typst directory is incomplete or modified: {destination}. "
            "Remove this build cache and retry."
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="paper-tools-typst-") as raw_temporary:
        temporary = Path(raw_temporary)
        archive = temporary / TYPST_ARCHIVE_NAME
        request = urllib.request.Request(
            TYPST_DOWNLOAD_URL,
            headers={"User-Agent": "paper_tools-desktop-build"},
        )
        digest = hashlib.sha256()
        with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
        actual_digest = digest.hexdigest()
        if actual_digest != TYPST_ARCHIVE_SHA256:
            raise RuntimeError(
                f"Typst archive SHA-256 mismatch: expected {TYPST_ARCHIVE_SHA256}, "
                f"got {actual_digest}"
            )

        extracted = temporary / "extracted"
        _safe_extract(archive, extracted)
        executables = list(extracted.rglob("typst.exe"))
        if len(executables) != 1:
            raise RuntimeError("The Typst archive did not contain exactly one typst.exe")
        source_root = executables[0].parent
        staged = temporary / "staged"
        staged.mkdir()
        shutil.copy2(executables[0], staged / "typst.exe")
        for name in ("LICENSE", "NOTICE", "README.md"):
            source = source_root / name
            if source.is_file():
                shutil.copy2(source, staged / name)
        if not (staged / "LICENSE").is_file():
            raise RuntimeError("The Typst archive did not include its LICENSE file")
        manifest = {
            "name": "Typst",
            "version": TYPST_VERSION,
            "source": TYPST_DOWNLOAD_URL,
            "archive_sha256": TYPST_ARCHIVE_SHA256,
            "typst_sha256": sha256_file(staged / "typst.exe"),
        }
        (staged / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + os.linesep,
            encoding="utf-8",
        )
        shutil.copytree(staged, destination)
    return destination / "typst.exe"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--destination",
        type=Path,
        default=PROJECT_ROOT / "vendor" / "typst",
    )
    arguments = parser.parse_args()
    executable = fetch_typst(arguments.destination.resolve(strict=False))
    print(f"Typst {TYPST_VERSION} ready: {executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
