from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.web._support import WebHarness, open_web_harness


@pytest.fixture
def web_app(tmp_path: Path) -> Iterator[WebHarness]:
    with open_web_harness(tmp_path) as harness:
        yield harness
