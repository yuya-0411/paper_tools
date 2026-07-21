"""PyInstaller entry point kept deliberately small and import-explicit."""

from __future__ import annotations

import multiprocessing
import sys

from paper_tools.desktop import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main(sys.argv[1:]))
