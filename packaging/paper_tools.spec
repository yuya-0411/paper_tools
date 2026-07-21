# -*- mode: python ; coding: utf-8 -*-

import re
import sys
from importlib.metadata import distributions
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

project_root = Path(SPECPATH).parent
source_root = project_root / "src"
vendor_root = project_root / "vendor" / "typst"
typst_executable = vendor_root / "typst.exe"
if not typst_executable.is_file():
    raise SystemExit("Run scripts/fetch_typst.py before building the desktop application")


def collect_python_license_files():
    """Collect the interpreter and installed-package notices used by the build."""

    collected = []
    interpreter_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not interpreter_license.is_file():
        raise SystemExit(f"Python license file was not found: {interpreter_license}")
    collected.append((str(interpreter_license), "licenses/python"))

    seen = set()
    for installed in distributions():
        metadata_name = installed.metadata.get("Name") or "unknown-package"
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", metadata_name).strip("-")
        for entry in installed.files or ():
            leaf = entry.name.casefold()
            if not leaf.startswith(("license", "copying", "notice")):
                continue
            source = Path(installed.locate_file(entry))
            if not source.is_file():
                continue
            key = source.resolve(strict=False)
            if key in seen:
                continue
            seen.add(key)
            relative_parent = Path(*entry.parts[:-1])
            destination = Path("licenses") / "python-packages" / safe_name / relative_parent
            collected.append((str(source), str(destination)))
    return collected

datas = collect_data_files(
    "paper_tools",
    includes=[
        "templates/**/*.j2",
        "templates/**/*.yml",
        "templates/**/*.png",
        "web/templates/**/*.html",
        "web/static/**/*.css",
        "web/static/**/*.js",
        "web/static/**/*.txt",
    ],
)
datas.extend(collect_python_license_files())
for license_name in ("LICENSE", "NOTICE", "README.md", "manifest.json"):
    license_path = vendor_root / license_name
    if license_path.is_file():
        datas.append((str(license_path), "licenses/typst"))

binaries = [(str(typst_executable), "paper_tools/vendor/typst")]
hidden_imports = [
    "PIL.Image",
    "PIL.ImageDraw",
    "pystray",
    "pystray._win32",
    "sqlalchemy.dialects.sqlite.pysqlite",
    "uvicorn.lifespan.on",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.h11_impl",
]

a = Analysis(
    [str(project_root / "packaging" / "frozen_entry.py")],
    pathex=[str(source_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pystray._appindicator",
        "pystray._darwin",
        "pystray._gtk",
        "pystray._xorg",
        "uvicorn.loops.uvloop",
        "uvicorn.protocols.http.httptools_impl",
        "watchfiles",
        "websockets",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="paper_tools",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="paper_tools",
)
