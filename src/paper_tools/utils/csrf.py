"""Double-submit CSRF token helpers for local form posts."""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request
from starlette.responses import Response

COOKIE_NAME = "paper_tools_csrf"


def ensure_csrf_token(request: Request, response: Response) -> str:
    token = request.cookies.get(COOKIE_NAME)
    if not token or len(token) < 32:
        token = secrets.token_urlsafe(32)
        response.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/",
        )
    return token


def validate_csrf(request: Request, submitted: str) -> None:
    expected = request.cookies.get(COOKIE_NAME, "")
    if not expected or not submitted or not secrets.compare_digest(expected, submitted):
        raise HTTPException(
            status_code=403, detail="フォームの有効期限が切れました．再読込してください．"
        )
