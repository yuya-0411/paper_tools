"""FastAPI dependencies bound to the application instance."""

from __future__ import annotations

from collections.abc import Generator
from typing import cast

from fastapi import Request
from sqlalchemy.orm import Session

from paper_tools.config import AppSettings
from paper_tools.database import Database
from paper_tools.services.jobs import JobManager


def get_settings(request: Request) -> AppSettings:
    return cast(AppSettings, request.app.state.settings)


def get_database(request: Request) -> Database:
    return cast(Database, request.app.state.database)


def get_session(request: Request) -> Generator[Session, None, None]:
    database: Database = request.app.state.database
    with database.session() as session:
        yield session


def get_job_manager(request: Request) -> JobManager:
    return cast(JobManager, request.app.state.jobs)


def csrf_token(request: Request) -> str:
    return str(request.state.csrf_token)
