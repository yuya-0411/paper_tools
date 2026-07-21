"""Application configuration loaded from environment variables.

The application is local-first.  Defaults deliberately bind the web server to
loopback and keep all mutable state below one user-owned data directory.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from paper_tools.bundled import default_typst_executable

DEFAULT_UPLOAD_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".svg", ".pdf", ".csv", ".json", ".txt", ".yaml", ".yml"}
)
RUNTIME_SETTING_FIELDS = frozenset(
    {
        "typst_executable",
        "compile_timeout_seconds",
        "upload_max_bytes",
        "backup_count",
        "generation_provider",
        "generation_timeout_seconds",
        "generation_temperature",
        "maximum_output_tokens",
        "ollama_url",
        "ollama_model",
        "openai_compatible_base_url",
        "openai_compatible_model",
        "japanese_punctuation",
        "english_variant",
    }
)


def default_data_dir() -> Path:
    """Return a platform-appropriate per-user data directory without creating it."""

    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "paper_tools"
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home) / "paper_tools"
    return Path.home() / ".local" / "share" / "paper_tools"


class AppSettings(BaseSettings):
    """Validated settings for the web application and local services."""

    model_config = SettingsConfigDict(
        env_prefix="PAPER_TOOLS_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "paper_tools"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    debug: bool = False

    data_dir: Path = Field(default_factory=default_data_dir)
    database_url: str | None = None
    upload_max_bytes: int = Field(default=20 * 1024 * 1024, ge=1)
    allowed_upload_extensions: frozenset[str] = DEFAULT_UPLOAD_EXTENSIONS
    backup_count: int = Field(default=10, ge=0, le=1000)
    autosave_delay_seconds: float = Field(default=1.5, ge=0.1, le=300)

    typst_executable: str = Field(default_factory=default_typst_executable)
    compile_timeout_seconds: float = Field(default=60.0, gt=0, le=3600)

    generation_provider: Literal["rule-based", "ollama", "openai-compatible", "mock"] = "rule-based"
    generation_timeout_seconds: float = Field(default=120.0, gt=0, le=3600)
    generation_temperature: float = Field(default=0.2, ge=0, le=2)
    maximum_output_tokens: int = Field(default=4096, ge=1, le=1_000_000)

    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = ""
    openai_compatible_base_url: str = ""
    openai_compatible_model: str = ""
    openai_api_key: SecretStr | None = Field(default=None, repr=False)

    japanese_punctuation: Literal["，．", "、。"] = "，．"
    english_variant: Literal["american", "british"] = "american"

    @field_validator("data_dir", mode="before")
    @classmethod
    def expand_data_dir(cls, value: object) -> object:
        if isinstance(value, (str, Path)):
            return Path(value).expanduser()
        return value

    @field_validator("allowed_upload_extensions", mode="before")
    @classmethod
    def parse_extensions(cls, value: object) -> object:
        if isinstance(value, str):
            value = [part.strip() for part in value.split(",") if part.strip()]
        if isinstance(value, (list, tuple, set, frozenset)):
            return frozenset(
                extension.lower() if str(extension).startswith(".") else f".{extension.lower()}"
                for extension in (str(item).strip() for item in value)
                if extension
            )
        return value

    @field_validator("ollama_url", "openai_compatible_base_url")
    @classmethod
    def validate_provider_url(cls, value: str, info: object) -> str:
        cleaned = value.strip()
        field_name = getattr(info, "field_name", "")
        if not cleaned and field_name == "openai_compatible_base_url":
            return cleaned
        try:
            parsed = urlsplit(cleaned)
            _ = parsed.port
        except ValueError as exc:
            raise ValueError("プロバイダーURLが不正です") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("プロバイダーURLは秘密情報を含まないHTTP(S) URLで指定してください")
        local_hosts = {"localhost", "127.0.0.1", "::1"}
        if (
            field_name == "openai_compatible_base_url"
            and parsed.scheme != "https"
            and parsed.hostname not in local_hosts
        ):
            raise ValueError("外部OpenAI互換APIにはHTTPS URLを指定してください")
        return cleaned.rstrip("/")

    @model_validator(mode="after")
    def normalize_paths_and_database(self) -> AppSettings:
        self.data_dir = self.data_dir.resolve(strict=False)
        if self.database_url is None:
            database_path = (self.data_dir / "paper_tools.sqlite3").as_posix()
            self.database_url = f"sqlite+pysqlite:///{database_path}"
        if not self.database_url.startswith(("sqlite://", "sqlite+pysqlite://")):
            raise ValueError("paper_tools currently supports SQLite database URLs only")
        return self

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    def ensure_directories(self) -> None:
        """Create only the application-owned directories needed at runtime."""

        for path in (self.data_dir, self.projects_dir, self.exports_dir):
            path.mkdir(parents=True, exist_ok=True)


# A concise compatibility name for application/bootstrap code.
Settings = AppSettings


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    """Return the process-wide validated settings instance."""

    return AppSettings()


def reset_settings_cache() -> None:
    """Clear cached settings, primarily for isolated tests and CLI reconfiguration."""

    get_settings.cache_clear()


__all__ = [
    "DEFAULT_UPLOAD_EXTENSIONS",
    "RUNTIME_SETTING_FIELDS",
    "AppSettings",
    "Settings",
    "default_data_dir",
    "get_settings",
    "reset_settings_cache",
]
