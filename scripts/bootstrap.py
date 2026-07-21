"""Create the local environment once, then start paper_tools.

This script intentionally uses only the Python standard library so it can run
before the project dependencies have been installed.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENV_DIR = PROJECT_ROOT / ".paper-tools-venv"
FINGERPRINT_FILE = VENV_DIR / ".paper-tools-dependencies.sha256"
MINIMUM_PYTHON = (3, 11)


def dependency_fingerprint() -> str:
    """Hash the files that determine the local Python environment."""

    digest = hashlib.sha256()
    for filename in ("pyproject.toml", "uv.lock"):
        path = PROJECT_ROOT / filename
        digest.update(filename.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def venv_python() -> Path:
    """Return the virtual environment's interpreter path."""

    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def ensure_supported_python() -> None:
    """Fail early with a readable message when Python is too old."""

    if sys.version_info < MINIMUM_PYTHON:
        required = ".".join(str(part) for part in MINIMUM_PYTHON)
        current = f"{sys.version_info.major}.{sys.version_info.minor}"
        raise RuntimeError(f"Python {required}以上が必要です（現在は{current}）．")


def environment_is_current(interpreter: Path, fingerprint: str) -> bool:
    """Return whether the editable install and its dependency marker are usable."""

    if not interpreter.is_file() or not FINGERPRINT_FILE.is_file():
        return False
    if FINGERPRINT_FILE.read_text(encoding="ascii").strip() != fingerprint:
        return False
    try:
        check = subprocess.run(
            [
                str(interpreter),
                "-c",
                "import fastapi, paper_tools, sqlalchemy, uvicorn",
            ],
            cwd=PROJECT_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    return check.returncode == 0


def interpreter_is_usable(interpreter: Path) -> bool:
    """Return whether an existing launcher environment can execute Python."""

    if not interpreter.is_file():
        return False
    try:
        check = subprocess.run(
            [str(interpreter), "-c", "import sys; raise SystemExit(sys.version_info < (3, 11))"],
            cwd=PROJECT_ROOT,
            check=False,
            capture_output=True,
        )
    except OSError:
        return False
    return check.returncode == 0


def prepare_environment() -> Path:
    """Create or refresh the project-local virtual environment."""

    ensure_supported_python()
    interpreter = venv_python()
    if not interpreter_is_usable(interpreter):
        print("[1/2] 初回用のPython環境を作成しています…", flush=True)
        if VENV_DIR.exists():
            shutil.rmtree(VENV_DIR)
        venv.EnvBuilder(with_pip=True).create(VENV_DIR)
    fingerprint = dependency_fingerprint()
    if not environment_is_current(interpreter, fingerprint):
        print("[2/2] 必要なライブラリを準備しています（初回のみ数分かかります）…", flush=True)
        subprocess.run(
            [
                str(interpreter),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "-e",
                str(PROJECT_ROOT),
            ],
            cwd=PROJECT_ROOT,
            check=True,
        )
        FINGERPRINT_FILE.write_text(fingerprint, encoding="ascii")
    return interpreter


def run_application(interpreter: Path) -> int:
    """Run the browser-opening CLI in the foreground."""

    command = [str(interpreter), "-m", "paper_tools", "launch"]
    if os.environ.get("PAPER_TOOLS_LAUNCH_NO_BROWSER") == "1":
        command.append("--no-browser")
    print("paper_toolsを起動します．この画面を閉じると停止します．", flush=True)
    try:
        return subprocess.run(command, cwd=PROJECT_ROOT, check=False).returncode
    except KeyboardInterrupt:
        print("\npaper_toolsを停止しました．", flush=True)
        return 0


def main() -> int:
    try:
        interpreter = prepare_environment()
        return run_application(interpreter)
    except subprocess.CalledProcessError as exc:
        print(f"\nセットアップに失敗しました（終了コード: {exc.returncode}）．", file=sys.stderr)
        print("インターネット接続を確認して、もう一度起動してください．", file=sys.stderr)
        return exc.returncode or 1
    except (OSError, RuntimeError) as exc:
        print(f"\n起動できませんでした: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
