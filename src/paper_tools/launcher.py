"""Helpers for opening the local web UI from a one-click launcher."""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
import webbrowser
from collections.abc import Callable

logger = logging.getLogger(__name__)

ReadyCheck = Callable[[str], bool]
BrowserOpener = Callable[[str], object]


def application_url(host: str, port: int) -> str:
    """Return the browser URL for a configured server bind address."""

    browser_host = host.strip()
    if browser_host in {"", "0.0.0.0", "::"}:
        browser_host = "127.0.0.1"
    if ":" in browser_host and not browser_host.startswith("["):
        browser_host = f"[{browser_host}]"
    return f"http://{browser_host}:{port}/"


def is_paper_tools_ready(base_url: str, *, timeout_seconds: float = 0.5) -> bool:
    """Return whether ``base_url`` exposes this application's health endpoint."""

    health_url = f"{base_url.rstrip('/')}/healthz"
    request = urllib.request.Request(health_url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                return False
            payload = json.load(response)
    except (OSError, ValueError):
        return False
    return (
        isinstance(payload, dict)
        and payload.get("app") == "paper_tools"
        and payload.get("status") == "ok"
    )


def open_in_default_browser(base_url: str) -> bool:
    """Open the application in a new tab of the user's default browser."""

    return webbrowser.open(base_url, new=2)


def schedule_browser_open(
    base_url: str,
    *,
    timeout_seconds: float = 30.0,
    poll_interval_seconds: float = 0.15,
    ready_check: ReadyCheck | None = None,
    opener: BrowserOpener | None = None,
) -> threading.Thread:
    """Open the browser after the application is ready, without blocking Uvicorn."""

    if timeout_seconds <= 0 or poll_interval_seconds <= 0:
        raise ValueError("timeout and poll interval must be positive")
    selected_ready_check = ready_check or is_paper_tools_ready
    selected_opener = opener or open_in_default_browser

    def wait_and_open() -> None:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if selected_ready_check(base_url):
                try:
                    selected_opener(base_url)
                except OSError:
                    logger.warning("Could not open the default browser", exc_info=True)
                return
            threading.Event().wait(poll_interval_seconds)
        logger.warning("The web UI did not become ready before browser-open timeout")

    thread = threading.Thread(
        target=wait_and_open,
        name="paper-tools-browser-launcher",
        daemon=True,
    )
    thread.start()
    return thread


__all__ = [
    "application_url",
    "is_paper_tools_ready",
    "open_in_default_browser",
    "schedule_browser_open",
]
