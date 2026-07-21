from __future__ import annotations

import urllib.error
from pathlib import Path

import pytest

from paper_tools import launcher


class _JsonResponse:
    status = 200

    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> _JsonResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _size: int = -1) -> bytes:
        return self.payload


def test_application_url_maps_bind_addresses_to_browser_addresses() -> None:
    assert launcher.application_url("127.0.0.1", 8000) == "http://127.0.0.1:8000/"
    assert launcher.application_url("localhost", 8123) == "http://localhost:8123/"
    assert launcher.application_url("0.0.0.0", 8000) == "http://127.0.0.1:8000/"
    assert launcher.application_url("::", 8000) == "http://127.0.0.1:8000/"
    assert launcher.application_url("::1", 8000) == "http://[::1]:8000/"


def test_readiness_requires_the_paper_tools_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        launcher.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _JsonResponse(
            b'{"app":"paper_tools","status":"ok","version":"0.2.0"}'
        ),
    )
    assert launcher.is_paper_tools_ready("http://127.0.0.1:8000/")

    monkeypatch.setattr(
        launcher.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _JsonResponse(b'{"app":"another-service","status":"ok"}'),
    )
    assert not launcher.is_paper_tools_ready("http://127.0.0.1:8000/")

    def offline(*_args: object, **_kwargs: object) -> _JsonResponse:
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(launcher.urllib.request, "urlopen", offline)
    assert not launcher.is_paper_tools_ready("http://127.0.0.1:8000/")


def test_browser_is_opened_only_after_readiness() -> None:
    attempts = 0
    opened: list[str] = []

    def ready(_url: str) -> bool:
        nonlocal attempts
        attempts += 1
        return attempts >= 3

    thread = launcher.schedule_browser_open(
        "http://127.0.0.1:8000/",
        timeout_seconds=1,
        poll_interval_seconds=0.001,
        ready_check=ready,
        opener=opened.append,
    )
    thread.join(timeout=1)

    assert not thread.is_alive()
    assert attempts == 3
    assert opened == ["http://127.0.0.1:8000/"]


@pytest.mark.parametrize("timeout,poll", [(0, 0.1), (1, 0), (-1, 0.1)])
def test_browser_scheduler_rejects_non_positive_delays(timeout: float, poll: float) -> None:
    with pytest.raises(ValueError, match="positive"):
        launcher.schedule_browser_open(
            "http://127.0.0.1:8000/",
            timeout_seconds=timeout,
            poll_interval_seconds=poll,
        )


def test_one_click_and_static_site_assets_are_present() -> None:
    project_root = Path(__file__).resolve().parents[2]
    command = (project_root / "START_PAPER_TOOLS.cmd").read_text(encoding="utf-8")
    bootstrap = (project_root / "scripts" / "bootstrap.py").read_text(encoding="utf-8")
    landing = (project_root / "site" / "index.html").read_text(encoding="utf-8")
    gitignore = (project_root / ".gitignore").read_text(encoding="utf-8")

    assert "scripts\\bootstrap.py" in command
    assert "Python 3.11" in command
    assert '"launch"' in bootstrap
    assert 'VENV_DIR = PROJECT_ROOT / ".paper-tools-venv"' in bootstrap
    assert "paper-tools-setup-x64.exe" in landing
    assert "releases/latest/download" in landing
    assert "Python、pip、仮想環境、Typstはすべて同梱" in landing
    assert "GitHub Pages" in landing
    assert 'src="/' not in landing
    assert 'href="/' not in landing
    assert "\n/projects/\n" in f"\n{gitignore}"
    assert "\nprojects/\n" not in f"\n{gitignore}"
