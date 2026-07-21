from __future__ import annotations

import json
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from paper_tools import desktop
from paper_tools.config import AppSettings


def _settings(tmp_path: Path, *, port: int = 0) -> AppSettings:
    return AppSettings(data_dir=tmp_path / "data", database_url=None, port=port or 8000)


def test_configure_desktop_logging_creates_rotating_log(tmp_path: Path) -> None:
    path = desktop.configure_desktop_logging(tmp_path / "data")

    assert path == tmp_path / "data" / "logs" / "paper_tools.log"
    assert path.parent.is_dir()
    desktop.close_desktop_logging(path)


def test_choose_available_port_uses_preferred_then_falls_back() -> None:
    preferred = desktop.choose_available_port("127.0.0.1", 0)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        occupied_port = int(occupied.getsockname()[1])
        fallback = desktop.choose_available_port("127.0.0.1", occupied_port)

    assert 0 < preferred <= 65535
    assert fallback != occupied_port


def test_instance_coordinator_locks_publishes_and_clears(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = desktop.InstanceCoordinator(tmp_path / "data")
    second = desktop.InstanceCoordinator(tmp_path / "data")
    monkeypatch.setattr(desktop, "is_paper_tools_ready", lambda _url: True)

    assert first.acquire()
    first.publish("http://127.0.0.1:8123")
    assert second.acquire() is False
    assert second.discover(timeout_seconds=0.2) == "http://127.0.0.1:8123"
    first.clear()
    first.release()
    assert not first.state_path.exists()
    assert second.acquire()
    second.release()


def test_instance_coordinator_ignores_invalid_state(tmp_path: Path) -> None:
    coordinator = desktop.InstanceCoordinator(tmp_path / "data")
    coordinator.data_dir.mkdir(parents=True)
    coordinator.state_path.write_text("not-json", encoding="utf-8")

    assert coordinator.discover(timeout_seconds=0.01) is None
    coordinator.clear()


def test_desktop_server_starts_and_stops_real_fastapi(tmp_path: Path) -> None:
    port = desktop.choose_available_port("127.0.0.1", 0)
    settings = AppSettings(
        data_dir=tmp_path / "data",
        database_url=None,
        host="127.0.0.1",
        port=port,
    )
    server = desktop.DesktopServer(settings)

    server.start(timeout_seconds=10)
    assert desktop.is_paper_tools_ready(server.url)
    server.stop()
    assert not server.thread.is_alive()


def test_run_desktop_coordinates_server_and_tray(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    events: list[str] = []

    class FakeServer:
        def __init__(self, selected: AppSettings) -> None:
            self.settings = selected
            self.url = f"http://127.0.0.1:{selected.port}"

        def start(self) -> None:
            events.append("start")

        def stop(self) -> None:
            events.append("stop")

    monkeypatch.setattr(desktop, "get_settings", lambda: settings)
    monkeypatch.setattr(desktop, "DesktopServer", FakeServer)
    monkeypatch.setattr(
        desktop,
        "run_tray",
        lambda server, data_dir, *, open_browser: events.append(
            f"tray:{server.url}:{data_dir.name}:{open_browser}"
        ),
    )
    monkeypatch.setattr(desktop, "choose_available_port", lambda _host, port: port)

    assert desktop.run_desktop(open_browser=False) == 0
    assert events == ["start", "tray:http://127.0.0.1:8000:data:False", "stop"]
    assert not (settings.data_dir / "desktop.json").exists()


def test_run_desktop_focuses_existing_instance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(tmp_path)
    owner = desktop.InstanceCoordinator(settings.data_dir)
    assert owner.acquire()
    owner.publish("http://127.0.0.1:9000")
    opened: list[str] = []
    monkeypatch.setattr(desktop, "get_settings", lambda: settings)
    monkeypatch.setattr(desktop, "is_paper_tools_ready", lambda _url: True)
    monkeypatch.setattr(desktop, "open_in_default_browser", opened.append)

    try:
        assert desktop.run_desktop() == 0
    finally:
        owner.clear()
        owner.release()

    assert opened == ["http://127.0.0.1:9000"]


def test_run_self_test_checks_web_assets_and_compiler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report_path = tmp_path / "report.json"
    monkeypatch.setenv("PAPER_TOOLS_SELF_TEST_REPORT", str(report_path))

    class FakeCompiler:
        def __init__(self, _executable: str, *, timeout: float) -> None:
            assert timeout == 30

        def version(self) -> str:
            return "typst 0.test"

        def compile(
            self,
            _main_path: Path,
            output_path: Path,
            *,
            project_root: Path,
        ) -> Any:
            assert project_root.is_dir()
            output_path.write_bytes(b"%PDF-1.7\n")
            return SimpleNamespace(success=True)

    monkeypatch.setattr(desktop, "TypstCompileService", FakeCompiler)

    assert desktop.run_self_test() == 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["typst"] == "typst 0.test"


def test_run_self_test_writes_failure_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report_path = tmp_path / "report.json"
    monkeypatch.setenv("PAPER_TOOLS_SELF_TEST_REPORT", str(report_path))

    class MissingCompiler:
        def __init__(self, _executable: str, *, timeout: float) -> None:
            pass

        def version(self) -> None:
            return None

    monkeypatch.setattr(desktop, "TypstCompileService", MissingCompiler)

    assert desktop.run_self_test() == 1
    assert json.loads(report_path.read_text(encoding="utf-8"))["ok"] is False


def test_run_tray_opens_browser_and_exposes_menu(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    opened: list[str] = []

    class FakeThread:
        def join(self) -> None:
            return None

    class FakeMenuItem:
        def __init__(self, label: str, action: Any, **kwargs: Any) -> None:
            self.label = label
            self.action = action
            self.kwargs = kwargs

    class FakeMenu:
        SEPARATOR = object()

        def __init__(self, *items: object) -> None:
            self.items = items

    class FakeIcon:
        def __init__(self, *_args: object, menu: FakeMenu, **_kwargs: object) -> None:
            self.menu = menu

        def run(self) -> None:
            return None

        def stop(self) -> None:
            return None

    fake_pystray = SimpleNamespace(Icon=FakeIcon, Menu=FakeMenu, MenuItem=FakeMenuItem)
    monkeypatch.setitem(sys.modules, "pystray", fake_pystray)
    monkeypatch.setattr(desktop, "_tray_image", lambda: object())
    monkeypatch.setattr(desktop, "open_in_default_browser", opened.append)
    server = SimpleNamespace(url="http://127.0.0.1:8000", thread=FakeThread())

    desktop.run_tray(server, tmp_path)

    assert opened == ["http://127.0.0.1:8000"]


def test_main_routes_to_self_test(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "run_self_test", lambda: 7)

    assert desktop.main(["--self-test"]) == 7
