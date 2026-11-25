"""Password hashing, JWT issuing and checking, and the role ranking."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

import jwt

from acme.core.config import Settings
from acme.core.http import Forbidden, Request, Unauthorized

if TYPE_CHECKING:
    import psycopg

ROLES = ("viewer", "contributor", "manager", "admin")
ROLE_RANK = {role: rank for rank, role in enumerate(ROLES)}

ACCESS_TTL = timedelta(minutes=30)
REFRESH_TTL = timedelta(days=7)
JWT_ALGORITHM = "HS256"
AUTH_SCHEME = "Bearer"
TYP_ACCESS = "access"
TYP_REFRESH = "refresh"

# The only routes a user with a temporary password may call until they change it
PASSWORD_CHANGE_ROUTES = frozenset(
    {("GET", "/auth/me"), ("POST", "/auth/change-password"), ("POST", "/auth/logout")}
)

# One primary-key lookup per authenticated request
_USER_STATE_QUERY = (
    "SELECT id, email, role, is_active, token_version, must_change_password "
    "FROM users WHERE id = %s"
)

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
    """Issue a 30-minute access token and a 7-day refresh token for a user row.

    Both carry the row's ``token_version`` as the claim ``ver``; a token whose ``ver`` no
    longer matches the row is revoked. The access token's ``role`` and ``email`` claims
    are informational: authorisation always uses the database row.
    """
    now = now or datetime.now(timezone.utc)
    version = int(user.get("token_version", 0))
    access_claims = {
        "sub": str(user["id"]),
        "role": user["role"],
        "email": user["email"],
        "typ": TYP_ACCESS,
        "ver": version,
        "iat": now,
        "exp": now + ACCESS_TTL,
    }
    refresh_claims = {
        "sub": str(user["id"]),
        "typ": TYP_REFRESH,
        "ver": version,
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
    """Verify signature, expiry, ``typ`` and the presence of ``ver``, and return the claims.

    Raises:
        Unauthorized: ``token_expired`` when expired, ``invalid_token`` for anything else,
            including a refresh token used where an access token is expected and a token
            without a version (issued before revocation existed).
    """
    try:
        claims = jwt.decode(
            encoded,
            settings.jwt_secret,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["exp", "iat", "sub", "typ", "ver"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Token has expired", code="token_expired") from exc
    except jwt.InvalidTokenError as exc:
        raise Unauthorized("Token is invalid", code="invalid_token") from exc
    if claims.get("typ") != expected_typ:
        article = "an" if expected_typ[:1] in "aeiou" else "a"
        raise Unauthorized(f"Expected {article} {expected_typ} token", code="invalid_token")
    if isinstance(claims["ver"], bool) or not isinstance(claims["ver"], int):
        raise Unauthorized("Token is invalid", code="invalid_token")
    return claims


def authenticate(headers: dict[str, str], settings: Settings) -> dict[str, Any]:
    """Read the Bearer access token from lower-cased headers and return who it names.

    This only proves the token is ours and unexpired. ``current_user()`` then loads the
    row, which decides the role and whether the token is still good.

    Returns:
        ``{"id": int, "role": str, "email": str, "ver": int}`` taken from the token.

    Raises:
        Unauthorized: If the header is missing or the token is not a valid access token.
    """
    scheme, _, credentials = headers.get("authorization", "").partition(" ")
    if scheme.lower() != AUTH_SCHEME.lower() or not credentials.strip():
        raise Unauthorized("Authorization: Bearer <access token> is required", code="missing_token")
    claims = decode_token(credentials.strip(), settings, TYP_ACCESS)
    if claims.get("role") not in ROLE_RANK or not str(claims["sub"]).isdigit():
        raise Unauthorized("Token is invalid", code="invalid_token")
    return {
        "id": int(claims["sub"]),
        "role": claims["role"],
        "email": claims.get("email"),
        "ver": claims["ver"],
    }


def current_user(conn: psycopg.Connection, identity: dict[str, Any]) -> dict[str, Any]:
    """Re-read the user a verified token names: the database decides, not the token.

    Args:
        conn: Database connection.
        identity: What ``authenticate()`` returned.

    Returns:
        ``{"id", "role", "email", "must_change_password"}`` from the user row.

    Raises:
        Unauthorized: ``invalid_token`` when the user was deleted or deactivated,
            ``token_revoked`` when the token's version is not the row's.
    """
    row = conn.execute(_USER_STATE_QUERY, (identity["id"],)).fetchone()
    if row is None or not row["is_active"]:
        raise Unauthorized("This account no longer exists or is inactive", code="invalid_token")
    if identity["ver"] != row["token_version"]:
        raise Unauthorized("This session has ended. Sign in again.", code="token_revoked")
    return {
        "id": row["id"],
        "role": row["role"],
        "email": row["email"],
        "must_change_password": row["must_change_password"],
    }


def require_password_changed(user: dict[str, Any] | None, method: str, template: str) -> None:
    """Hold a user with a temporary password to the routes that let them replace it.

    The dispatcher calls this for every route that needs a token. ``POST /auth/refresh``
    is public, so its handler calls it with the user the refresh token names.

    Raises:
        Forbidden: ``password_change_required`` for any other route.
    """
    if user and user.get("must_change_password"):
        if (method, template) not in PASSWORD_CHANGE_ROUTES:
            raise Forbidden(
                "Change your temporary password before doing anything else",
                code="password_change_required",
            )


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
