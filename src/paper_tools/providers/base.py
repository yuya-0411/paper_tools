"""Provider protocol, safe HTTP transport, and fallback composition."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from paper_tools.schemas import GenerationRequest, GenerationResponse

_MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024


class _NoRedirectHandler(HTTPRedirectHandler):
    """Reject redirects before urllib can forward credentials or read their body."""

    def redirect_request(
        self,
        req: Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Request:
        del newurl
        fp.close()
        raise HTTPError(req.full_url, code, "provider redirects are not allowed", headers, fp)


class ProviderError(RuntimeError):
    """A sanitized generation failure safe to display without credentials."""


@dataclass(frozen=True, slots=True)
class ProviderHealth:
    available: bool
    message: str


@runtime_checkable
class TextGenerationProvider(Protocol):
    @property
    def name(self) -> str: ...

    async def generate(self, request: GenerationRequest) -> GenerationResponse: ...

    async def healthcheck(self) -> ProviderHealth: ...


class JSONTransport(Protocol):
    async def post_json(
        self,
        url: str,
        payload: Mapping[str, object],
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]: ...

    async def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]: ...


class UrllibJSONTransport:
    """Dependency-free async facade over bounded standard-library HTTP."""

    async def post_json(
        self,
        url: str,
        payload: Mapping[str, object],
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        return await asyncio.to_thread(
            self._request,
            url,
            body,
            {"Content-Type": "application/json", **headers},
            timeout,
        )

    async def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]:
        return await asyncio.to_thread(self._request, url, None, headers, timeout)

    @staticmethod
    def _request(
        url: str,
        body: bytes | None,
        headers: Mapping[str, str],
        timeout: float,
    ) -> Mapping[str, Any]:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username:
            raise ProviderError("プロバイダーURLが不正です")
        request = Request(url, data=body, headers=dict(headers), method="POST" if body else "GET")
        opener = build_opener(_NoRedirectHandler())
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(_MAX_HTTP_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raise ProviderError(f"プロバイダーがHTTP {exc.code}を返しました") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise ProviderError("プロバイダーへ接続できませんでした") from exc
        if len(raw) > _MAX_HTTP_RESPONSE_BYTES:
            raise ProviderError("プロバイダー応答がサイズ上限を超えました")
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError("プロバイダー応答が有効なJSONではありません") from exc
        if not isinstance(decoded, dict):
            raise ProviderError("プロバイダー応答の形式が不正です")
        return decoded


class FallbackProvider:
    """Use a local deterministic provider when an optional provider fails."""

    def __init__(
        self,
        primary: TextGenerationProvider,
        fallback: TextGenerationProvider,
    ) -> None:
        self.primary = primary
        self.fallback = fallback

    @property
    def name(self) -> str:
        return f"{self.primary.name}-with-{self.fallback.name}-fallback"

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        try:
            return await self.primary.generate(request)
        except (ProviderError, TimeoutError, OSError, ValueError) as exc:
            response = await self.fallback.generate(request)
            warning = f"{self.primary.name} failed; {self.fallback.name} was used: {exc}"
            return response.model_copy(
                update={
                    "fallback_used": True,
                    "warnings": [*response.warnings, warning],
                }
            )

    async def healthcheck(self) -> ProviderHealth:
        primary_health = await self.primary.healthcheck()
        if primary_health.available:
            return primary_health
        fallback_health = await self.fallback.healthcheck()
        return ProviderHealth(
            available=fallback_health.available,
            message=f"{primary_health.message}; fallback: {fallback_health.message}",
        )
