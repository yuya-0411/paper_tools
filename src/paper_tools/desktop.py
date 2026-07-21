"""Windows desktop lifecycle for the self-contained paper_tools distribution."""

from __future__ import annotations

import argparse
import ctypes
import importlib
import json
import logging
import os
import socket
import sys
import tempfile
import threading
import time
from contextlib import suppress
from logging.handlers import RotatingFileHandler
from pathlib import Path
from types import TracebackType
from typing import Any, BinaryIO, Self
from urllib.request import Request, urlopen

import uvicorn

from paper_tools import __version__
from paper_tools.app import create_app
from paper_tools.config import AppSettings, get_settings
from paper_tools.launcher import application_url, is_paper_tools_ready, open_in_default_browser
from paper_tools.services.typst_compiler import TypstCompileService

logger = logging.getLogger(__name__)

_DESKTOP_HOST = "127.0.0.1"
_STARTUP_TIMEOUT_SECONDS = 30.0
_INSTANCE_WAIT_SECONDS = 20.0


def configure_desktop_logging(data_dir: Path) -> Path:
    """Persist windowless-launch diagnostics below the application data directory."""

    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "paper_tools.log"
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    if not any(
        isinstance(handler, RotatingFileHandler)
        and Path(handler.baseFilename).resolve(strict=False) == log_path.resolve(strict=False)
        for handler in root_logger.handlers
    ):
        handler = RotatingFileHandler(
            log_path,
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root_logger.addHandler(handler)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).propagate = True
    return log_path


def close_desktop_logging(log_path: Path) -> None:
    """Release one desktop log so temporary self-test data can be removed on Windows."""

    root_logger = logging.getLogger()
    target = log_path.resolve(strict=False)
    for handler in tuple(root_logger.handlers):
        if (
            isinstance(handler, RotatingFileHandler)
            and Path(handler.baseFilename).resolve(strict=False) == target
        ):
            root_logger.removeHandler(handler)
            handler.close()


def show_desktop_error(title: str, message: str) -> None:
    """Show startup failures even though the packaged executable has no console."""

    logger.error("%s: %s", title, message)
    if os.name == "nt" and not os.environ.get("CI"):
        with suppress(OSError):
            ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)


def choose_available_port(host: str, preferred: int) -> int:
    """Use the configured port when free, otherwise ask Windows for a safe local port."""

    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if os.name == "nt":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                probe.bind((host, candidate))
            except OSError:
                if candidate == preferred:
                    continue
                raise
            return int(probe.getsockname()[1])
    raise RuntimeError("利用可能なローカルポートを確保できませんでした．")


class DesktopServer:
    """Run one in-process Uvicorn server with an explicit shutdown handle."""

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.url = application_url(settings.host, settings.port)
        config = uvicorn.Config(
            create_app(settings),
            host=settings.host,
            port=settings.port,
            loop="asyncio",
            http="h11",
            lifespan="on",
            log_config=None,
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(
            target=self.server.run,
            name="paper-tools-server",
            daemon=True,
        )

    def start(self, *, timeout_seconds: float = _STARTUP_TIMEOUT_SECONDS) -> None:
        self.thread.start()
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if is_paper_tools_ready(self.url):
                logger.info("Desktop server ready at %s", self.url)
                return
            if not self.thread.is_alive():
                raise RuntimeError("ローカルサーバーが起動前に終了しました．")
            time.sleep(0.1)
        self.stop()
        raise RuntimeError("ローカルサーバーの起動がタイムアウトしました．")

    def stop(self, *, timeout_seconds: float = 10.0) -> None:
        if not self.thread.is_alive():
            return
        self.server.should_exit = True
        self.thread.join(timeout=timeout_seconds)
        if self.thread.is_alive():
            self.server.force_exit = True
            self.thread.join(timeout=2.0)
        logger.info("Desktop server stopped")


class InstanceCoordinator:
    """Keep one desktop instance per user and publish its current local URL."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.lock_path = data_dir / "desktop.lock"
        self.state_path = data_dir / "desktop.json"
        self._stream: BinaryIO | None = None

    def acquire(self) -> bool:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        stream = self.lock_path.open("a+b")
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl = importlib.import_module("fcntl")
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            return False
        self._stream = stream
        return True

    def release(self) -> None:
        stream = self._stream
        if stream is None:
            return
        stream.seek(0)
        with suppress(OSError):
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl = importlib.import_module("fcntl")
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()
        self._stream = None

    def publish(self, url: str) -> None:
        payload = {
            "app": "paper_tools",
            "pid": os.getpid(),
            "url": url,
            "version": __version__,
        }
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, self.state_path)

    def discover(self, *, timeout_seconds: float = _INSTANCE_WAIT_SECONDS) -> str | None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            with suppress(OSError, ValueError, TypeError, json.JSONDecodeError):
                payload = json.loads(self.state_path.read_text(encoding="utf-8"))
                url = payload.get("url")
                if (
                    payload.get("app") == "paper_tools"
                    and isinstance(url, str)
                    and is_paper_tools_ready(url)
                ):
                    return url
            time.sleep(0.1)
        return None

    def clear(self) -> None:
        with suppress(OSError, ValueError, TypeError, json.JSONDecodeError):
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            if payload.get("pid") == os.getpid():
                self.state_path.unlink(missing_ok=True)

    def __enter__(self) -> Self:
        if not self.acquire():
            raise RuntimeError("paper_tools is already running")
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self.clear()
        self.release()


def _desktop_settings(base: AppSettings, port: int) -> AppSettings:
    values = base.model_dump()
    values.update({"host": _DESKTOP_HOST, "port": port})
    return AppSettings(**values)


def _open_data_directory(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        os.startfile(str(data_dir))
    else:
        open_in_default_browser(data_dir.as_uri())


def _tray_image() -> Any:
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (12, 91, 82, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((15, 9, 49, 55), radius=5, fill=(247, 250, 249, 255))
    draw.rectangle((22, 21, 42, 25), fill=(12, 91, 82, 255))
    draw.rectangle((22, 31, 42, 35), fill=(83, 125, 119, 255))
    draw.rectangle((22, 41, 36, 45), fill=(83, 125, 119, 255))
    return image


def run_tray(server: DesktopServer, data_dir: Path, *, open_browser: bool = True) -> None:
    """Keep the local server controllable from a small system-tray menu."""

    import pystray

    def open_app(_icon: Any = None, _item: Any = None) -> None:
        open_in_default_browser(server.url)

    def open_data(_icon: Any = None, _item: Any = None) -> None:
        _open_data_directory(data_dir)

    def stop_app(icon: Any, _item: Any = None) -> None:
        icon.stop()

    icon = pystray.Icon(
        "paper_tools",
        _tray_image(),
        "paper_tools",
        menu=pystray.Menu(
            pystray.MenuItem("paper_toolsを開く", open_app, default=True),
            pystray.MenuItem("データフォルダーを開く", open_data),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("終了", stop_app),
        ),
    )

    def stop_tray_if_server_exits() -> None:
        server.thread.join()
        with suppress(Exception):
            icon.stop()

    threading.Thread(
        target=stop_tray_if_server_exits,
        name="paper-tools-tray-monitor",
        daemon=True,
    ).start()
    if open_browser:
        open_app()
    icon.run()


def run_desktop(*, open_browser: bool = True) -> int:
    """Start or focus the one local desktop instance."""

    base_settings = get_settings()
    log_path = configure_desktop_logging(base_settings.data_dir)
    logger.info("Starting paper_tools desktop %s", __version__)
    coordinator = InstanceCoordinator(base_settings.data_dir)
    if not coordinator.acquire():
        existing_url = coordinator.discover()
        if existing_url is not None:
            if open_browser:
                open_in_default_browser(existing_url)
            return 0
        show_desktop_error(
            "paper_toolsを起動できません",
            f"別のpaper_toolsが起動中ですが，画面を開けませんでした．\n詳細: {log_path}",
        )
        return 1

    server: DesktopServer | None = None
    try:
        coordinator.state_path.unlink(missing_ok=True)
        port = choose_available_port(_DESKTOP_HOST, base_settings.port)
        settings = _desktop_settings(base_settings, port)
        server = DesktopServer(settings)
        server.start()
        coordinator.publish(server.url)
        run_tray(server, settings.data_dir, open_browser=open_browser)
        return 0
    except Exception as exc:
        logger.exception("Desktop startup failed")
        show_desktop_error(
            "paper_toolsを起動できません",
            f"起動中に問題が発生しました．\n{exc}\n\n詳細: {log_path}",
        )
        return 1
    finally:
        if server is not None:
            server.stop()
        coordinator.clear()
        coordinator.release()


def _request_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "paper_tools-self-test"})
    with urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError(f"Unexpected HTTP status {response.status}: {url}")
        payload: bytes = response.read()
        return payload.decode("utf-8")


def run_self_test() -> int:
    """Exercise the frozen server, bundled assets, database, and Typst binary."""

    report: dict[str, Any] = {"app": "paper_tools", "version": __version__, "ok": False}
    server: DesktopServer | None = None
    with tempfile.TemporaryDirectory(prefix="paper-tools-self-test-") as temporary:
        data_dir = Path(temporary) / "data"
        log_path = configure_desktop_logging(data_dir)
        try:
            base = get_settings()
            values = base.model_dump()
            values.update(
                {
                    "data_dir": data_dir,
                    "database_url": None,
                    "host": _DESKTOP_HOST,
                    "port": choose_available_port(_DESKTOP_HOST, 0),
                }
            )
            settings = AppSettings(**values)
            server = DesktopServer(settings)
            server.start()
            base_url = server.url.rstrip("/")
            health = json.loads(_request_text(f"{base_url}/healthz"))
            home = _request_text(f"{base_url}/")
            css = _request_text(f"{base_url}/static/app.css")
            if health.get("app") != "paper_tools" or "paper_tools" not in home or not css:
                raise RuntimeError("Web assets did not pass the desktop self-test")

            compiler = TypstCompileService(settings.typst_executable, timeout=30)
            typst_version = compiler.version()
            if not typst_version:
                raise RuntimeError("Bundled Typst is unavailable")
            project = data_dir / "self-test-project"
            project.mkdir(parents=True)
            main_path = project / "main.typ"
            output_path = project / "paper.pdf"
            main_path.write_text("= paper_tools self-test\n", encoding="utf-8")
            result = compiler.compile(main_path, output_path, project_root=project)
            if not result.success:
                raise RuntimeError("Bundled Typst could not create a PDF")
            report.update({"ok": True, "typst": typst_version})
            return 0
        except Exception as exc:
            report["error"] = str(exc)
            logger.exception("Desktop self-test failed")
            return 1
        finally:
            if server is not None:
                server.stop()
            report_path = os.environ.get("PAPER_TOOLS_SELF_TEST_REPORT")
            if report_path:
                Path(report_path).write_text(
                    json.dumps(report, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            close_desktop_logging(log_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="paper_tools")
    parser.add_argument("--self-test", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--no-browser", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args(argv)
    if arguments.self_test:
        return run_self_test()
    return run_desktop(open_browser=not arguments.no_browser)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


__all__ = [
    "DesktopServer",
    "InstanceCoordinator",
    "choose_available_port",
    "close_desktop_logging",
    "configure_desktop_logging",
    "main",
    "run_desktop",
    "run_self_test",
]
