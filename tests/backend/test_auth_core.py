"""Configuration, password hashing, JWT expiry and typ misuse, and the role ranking."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest

from acme.core import auth
from acme.core.config import ConfigError, Settings, load_settings
from acme.core.http import Forbidden, Request, Unauthorized

SETTINGS = Settings(
    db_host="h", db_port=5432, db_name="n", db_user="u", db_pass="p", is_local=True,
    jwt_secret="unit-test-signing-key-0123456789abcdef", seed_password=None,
)
USER = {"id": 7, "role": "manager", "email": "m@acme.test"}


def test_load_settings_requires_jwt_secret() -> None:
    with pytest.raises(ConfigError, match="JWT_SECRET is not set"):
        load_settings({"JWT_SECRET": "   "})


def test_load_settings_rejects_a_bad_port() -> None:
    with pytest.raises(ConfigError, match="POSTGRES_PORT"):
        load_settings({"JWT_SECRET": "x", "POSTGRES_PORT": "five"})


def test_load_settings_defaults_and_flags() -> None:
    settings = load_settings({"JWT_SECRET": "k", "IS_LOCAL": "TRUE", "SEED_PASSWORD": ""})
    assert (settings.db_host, settings.db_port, settings.db_name) == ("localhost", 5432, "postgres")
    assert settings.is_local is True
    assert settings.seed_password is None
    assert load_settings({"JWT_SECRET": "k", "IS_LOCAL": "false"}).is_local is False


def test_hash_password_salts_every_hash() -> None:
    first, second = auth.hash_password("correct horse"), auth.hash_password("correct horse")
    assert first != second
    assert first.startswith("scrypt$16384$8$1$")
    assert auth.verify_password("correct horse", first)
    assert auth.verify_password("correct horse", second)
    assert not auth.verify_password("wrong horse", first)


@pytest.mark.parametrize(
    "stored", ["", "plain", "md5$1$2$3$x$y", "scrypt$abc$8$1$AAAA$AAAA", "scrypt$16384$8$1$!!$??"]
)
def test_malformed_hashes_never_match(stored: str) -> None:
    assert auth.verify_password("anything", stored) is False


def test_burn_password_check_runs() -> None:
    auth.burn_password_check("whatever")
    assert auth._dummy_hash is not None


def _bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def test_access_token_round_trip() -> None:
    issued = auth.issue_tokens(USER, SETTINGS)
    assert issued["token_type"] == "Bearer"
    assert issued["expires_in"] == 1800
    assert auth.authenticate(_bearer(issued["access_token"]), SETTINGS) == USER


def test_token_lifetimes() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    issued = auth.issue_tokens(USER, SETTINGS, now=now)
    options = {"verify_exp": False}
    access = jwt.decode(issued["access_token"], SETTINGS.jwt_secret, ["HS256"], options=options)
    refresh = jwt.decode(issued["refresh_token"], SETTINGS.jwt_secret, ["HS256"], options=options)
    assert access["exp"] - access["iat"] == 30 * 60
    assert refresh["exp"] - refresh["iat"] == 7 * 24 * 3600
    assert (access["typ"], refresh["typ"]) == ("access", "refresh")


def test_expired_token_is_rejected() -> None:
    issued = auth.issue_tokens(USER, SETTINGS, now=datetime.now(timezone.utc) - timedelta(hours=1))
    with pytest.raises(Unauthorized) as caught:
        auth.authenticate(_bearer(issued["access_token"]), SETTINGS)
    assert caught.value.code == "token_expired"


def test_refresh_token_cannot_be_used_as_access_token() -> None:
    issued = auth.issue_tokens(USER, SETTINGS)
    with pytest.raises(Unauthorized) as caught:
        auth.authenticate(_bearer(issued["refresh_token"]), SETTINGS)
    assert caught.value.code == "invalid_token"


def test_access_token_cannot_be_used_as_refresh_token() -> None:
    issued = auth.issue_tokens(USER, SETTINGS)
    with pytest.raises(Unauthorized):
        auth.decode_token(issued["access_token"], SETTINGS, auth.TYP_REFRESH)


def test_token_signed_with_another_key_is_rejected() -> None:
    other = Settings(**{**SETTINGS.__dict__, "jwt_secret": "another-key-0123456789abcdef-xyz"})
    issued = auth.issue_tokens(USER, other)
    with pytest.raises(Unauthorized) as caught:
        auth.authenticate(_bearer(issued["access_token"]), SETTINGS)
    assert caught.value.code == "invalid_token"


@pytest.mark.parametrize(
    "headers",
    [{}, {"authorization": ""}, {"authorization": "Basic abc"}, {"authorization": "Bearer   "}],
)
def test_missing_or_wrong_scheme(headers: dict[str, str]) -> None:
    with pytest.raises(Unauthorized) as caught:
        auth.authenticate(headers, SETTINGS)
    assert caught.value.code == "missing_token"


def test_unknown_role_in_token_is_rejected() -> None:
    now = datetime.now(timezone.utc)
    claims = {"sub": "1", "role": "superuser", "typ": "access", "iat": now,
              "exp": now + timedelta(minutes=5)}
    forged = jwt.encode(claims, SETTINGS.jwt_secret, algorithm="HS256")
    with pytest.raises(Unauthorized):
        auth.authenticate(_bearer(forged), SETTINGS)


@pytest.mark.parametrize(
    ("role", "minimum", "allowed"),
    [
        ("viewer", "viewer", True),
        ("viewer", "contributor", False),
        ("contributor", "contributor", True),
        ("contributor", "manager", False),
        ("manager", "manager", True),
        ("manager", "admin", False),
        ("admin", "admin", True),
        ("admin", "viewer", True),
        ("nobody", "viewer", False),
    ],
)
def test_role_ranking(role: str, minimum: str, allowed: bool) -> None:
    assert auth.has_role(role, minimum) is allowed


def test_require_role() -> None:
    request = Request("GET", "/x", user={"id": 1, "role": "contributor", "email": None})
    auth.require_role(request, "contributor")
    with pytest.raises(Forbidden, match="manager"):
        auth.require_role(request, "manager")
    with pytest.raises(Unauthorized):
        auth.require_role(Request("GET", "/x"), "viewer")
