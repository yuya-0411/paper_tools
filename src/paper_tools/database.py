"""SQLite engine/session lifecycle with safe local defaults."""

from __future__ import annotations

import sqlite3
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from paper_tools.config import AppSettings, get_settings
from paper_tools.models import Base


def _is_memory_database(database_url: str) -> bool:
    database = make_url(database_url).database
    return database in (None, "", ":memory:")


def _prepare_sqlite_parent(database_url: str) -> None:
    database = make_url(database_url).database
    if database and database != ":memory:":
        Path(database).expanduser().resolve(strict=False).parent.mkdir(parents=True, exist_ok=True)


def create_database_engine(database_url: str, *, echo: bool = False) -> Engine:
    """Create a SQLAlchemy 2 engine configured consistently for SQLite."""

    if not database_url.startswith(("sqlite://", "sqlite+pysqlite://")):
        raise ValueError("paper_tools supports SQLite only")
    _prepare_sqlite_parent(database_url)
    kwargs: dict[str, Any] = {
        "connect_args": {"check_same_thread": False, "timeout": 30.0},
        "echo": echo,
    }
    if _is_memory_database(database_url):
        kwargs["poolclass"] = StaticPool
    engine = create_engine(database_url, **kwargs)

    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=30000")
            if not _is_memory_database(database_url):
                cursor.execute("PRAGMA journal_mode=WAL")
        finally:
            cursor.close()

    return engine


class Database:
    """Own an engine and typed session factory for one application database."""

    def __init__(
        self,
        settings: AppSettings | None = None,
        *,
        database_url: str | None = None,
        echo: bool | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        selected_url = database_url or self.settings.database_url
        if selected_url is None:  # guarded by AppSettings validation; keeps typing explicit
            raise ValueError("database_url is required")
        self.url = selected_url
        self.engine = create_database_engine(
            selected_url,
            echo=self.settings.debug if echo is None else echo,
        )
        self.session_factory: sessionmaker[Session] = sessionmaker(
            bind=self.engine,
            class_=Session,
            autoflush=False,
            expire_on_commit=False,
        )

    def initialize(self) -> None:
        """Create missing tables. This operation is safe to repeat."""

        Base.metadata.create_all(self.engine)

    def ping(self) -> bool:
        try:
            with self.engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return True
        except (OSError, sqlite3.Error, SQLAlchemyError):
            return False

    @contextmanager
    def session(self) -> Iterator[Session]:
        """Commit on success and reliably roll back/close on failure."""

        session = self.session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def dispose(self) -> None:
        self.engine.dispose()


_default_database: Database | None = None
_default_lock = Lock()


def configure_database(
    settings: AppSettings | None = None,
    *,
    database_url: str | None = None,
    initialize: bool = False,
) -> Database:
    """Replace the process-wide database, disposing the previous engine."""

    global _default_database
    with _default_lock:
        if _default_database is not None:
            _default_database.dispose()
        _default_database = Database(settings, database_url=database_url)
        if initialize:
            _default_database.initialize()
        return _default_database


def get_database(settings: AppSettings | None = None) -> Database:
    """Return the lazily created process-wide database."""

    global _default_database
    if _default_database is None:
        with _default_lock:
            if _default_database is None:
                _default_database = Database(settings)
    return _default_database


def init_database(settings: AppSettings | None = None) -> Database:
    database = get_database(settings)
    database.initialize()
    return database


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding one transactional session."""

    with get_database().session() as session:
        yield session


def reset_database() -> None:
    """Dispose and clear the global database, mainly for isolated tests."""

    global _default_database
    with _default_lock:
        if _default_database is not None:
            _default_database.dispose()
            _default_database = None


__all__ = [
    "Database",
    "configure_database",
    "create_database_engine",
    "get_database",
    "get_db",
    "init_database",
    "reset_database",
]
