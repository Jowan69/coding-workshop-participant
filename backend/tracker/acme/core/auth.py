"""Password hashing, JWT issuing and checking, and the role ranking."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from acme.core.config import Settings
from acme.core.http import Forbidden, Request, Unauthorized

ROLES = ("viewer", "contributor", "manager", "admin")
ROLE_RANK = {role: rank for rank, role in enumerate(ROLES)}

ACCESS_TTL = timedelta(minutes=30)
REFRESH_TTL = timedelta(days=7)
JWT_ALGORITHM = "HS256"
AUTH_SCHEME = "Bearer"
TYP_ACCESS = "access"
TYP_REFRESH = "refresh"

# scrypt cost: 2**14 * 8 * 128 bytes = 16 MiB of memory per hash, about 50 ms
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SALT_BYTES = 16
_KEY_BYTES = 32
_SCHEME = "scrypt"

_dummy_hash: str | None = None


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def hash_password(plain: str) -> str:
    """Hash a password with scrypt and a fresh random salt.

    Returns:
        ``scrypt$n$r$p$salt$key``, both base64, so the cost can change later.
    """
    salt = secrets.token_bytes(_SALT_BYTES)
    key = hashlib.scrypt(
        plain.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_KEY_BYTES
    )
    parts = (_SCHEME, str(_SCRYPT_N), str(_SCRYPT_R), str(_SCRYPT_P), _b64(salt), _b64(key))
    return "$".join(parts)


def verify_password(plain: str, stored: str) -> bool:
    """Check a password against a stored hash in constant time; malformed hashes never match."""
    try:
        scheme, n, r, p, salt_b64, key_b64 = stored.split("$")
        if scheme != _SCHEME:
            return False
        expected = base64.b64decode(key_b64, validate=True)
        actual = hashlib.scrypt(
            plain.encode("utf-8"),
            salt=base64.b64decode(salt_b64, validate=True),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, binascii.Error):
        return False
    return hmac.compare_digest(actual, expected)


def burn_password_check(plain: str) -> None:
    """Spend the same time as a real check, so unknown emails look like wrong passwords."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_urlsafe(16))
    verify_password(plain, _dummy_hash)


def issue_tokens(
    user: dict[str, Any], settings: Settings, now: datetime | None = None
) -> dict[str, Any]:
    """Issue a 30-minute access token and a 7-day refresh token for a user row."""
    now = now or datetime.now(timezone.utc)
    access_claims = {
        "sub": str(user["id"]),
        "role": user["role"],
        "email": user["email"],
        "typ": TYP_ACCESS,
        "iat": now,
        "exp": now + ACCESS_TTL,
    }
    refresh_claims = {
        "sub": str(user["id"]),
        "typ": TYP_REFRESH,
        "iat": now,
        "exp": now + REFRESH_TTL,
    }
    return {
        "access_token": jwt.encode(access_claims, settings.jwt_secret, algorithm=JWT_ALGORITHM),
        "refresh_token": jwt.encode(refresh_claims, settings.jwt_secret, algorithm=JWT_ALGORITHM),
        "token_type": AUTH_SCHEME,
        "expires_in": int(ACCESS_TTL.total_seconds()),
    }


def decode_token(encoded: str, settings: Settings, expected_typ: str) -> dict[str, Any]:
    """Verify signature, expiry and ``typ``, and return the claims.

    Raises:
        Unauthorized: ``token_expired`` when expired, ``invalid_token`` for anything else,
            including a refresh token used where an access token is expected.
    """
    try:
        claims = jwt.decode(
            encoded,
            settings.jwt_secret,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "iat", "sub", "typ"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Token has expired", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise Unauthorized("Token is invalid", code="invalid_token") from exc
    if claims.get("typ") != expected_typ:
        raise Unauthorized(f"Expected an {expected_typ} token", code="invalid_token")
    return claims


def authenticate(headers: dict[str, str], settings: Settings) -> dict[str, Any]:
    """Read the Bearer access token from lower-cased headers and return the caller.

    Returns:
        ``{"id": int, "role": str, "email": str}`` taken from the token.

    Raises:
        Unauthorized: If the header is missing or the token is not a valid access token.
    """
    scheme, _, credentials = headers.get("authorization", "").partition(" ")
    if scheme.lower() != AUTH_SCHEME.lower() or not credentials.strip():
        raise Unauthorized("Authorization: Bearer <access token> is required", code="missing_token")
    claims = decode_token(credentials.strip(), settings, TYP_ACCESS)
    if claims.get("role") not in ROLE_RANK or not str(claims["sub"]).isdigit():
        raise Unauthorized("Token is invalid", code="invalid_token")
    return {"id": int(claims["sub"]), "role": claims["role"], "email": claims.get("email")}


def has_role(role: str, minimum: str) -> bool:
    """True when ``role`` ranks at or above ``minimum`` (viewer < contributor < manager < admin)."""
    return ROLE_RANK.get(role, -1) >= ROLE_RANK[minimum]


def require_role(request: Request, minimum: str) -> None:
    """Raise unless the authenticated caller has at least the ``minimum`` role.

    Raises:
        Unauthorized: If nobody is authenticated.
        Forbidden: If the caller's role ranks below ``minimum``.
    """
    if request.user is None:
        raise Unauthorized("Authentication is required", code="missing_token")
    if not has_role(request.user["role"], minimum):
        raise Forbidden(f"This action requires the {minimum} role or higher")
