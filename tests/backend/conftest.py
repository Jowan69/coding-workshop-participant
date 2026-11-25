"""Shared fixtures: the acme_test database, a Lambda event factory and tokens per role.

Every test runs inside a transaction on the handler's own connection that is rolled back
afterwards, so tests are independent and the seeded demo data stays intact. Tests marked
``no_rollback`` opt out (they manage the connection themselves).
"""

from __future__ import annotations

import base64
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import psycopg
import pytest
from psycopg import sql

ROOT = Path(__file__).resolve().parents[2]
TEST_DB = "acme_test"
PG_PASSWORD = os.environ.get("PGPASSWORD", "postgres123")
SEED_PASSWORD = "Seed-Pass-123"
CLOUD_PREFIX = "/api/tracker"

os.environ.update(
    {
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_NAME": TEST_DB,
        "POSTGRES_USER": "postgres",
        "POSTGRES_PASS": PG_PASSWORD,
        "IS_LOCAL": "true",
        "JWT_SECRET": "test-only-signing-key-0123456789abcdef",
        "SEED_PASSWORD": SEED_PASSWORD,
    }
)
# Append, not insert: the venv's packages must win over any start-dev.sh vendored there
sys.path.append(str(ROOT / "backend" / "tracker"))

ROLE_EMAILS = {
    "admin": "admin@acme.test",
    "manager": "manager@acme.test",
    "contributor": "lead@acme.test",
    "viewer": "viewer@acme.test",
}


def _admin_connect(dbname: str) -> psycopg.Connection:
    return psycopg.connect(
        host="localhost", port=5432, user="postgres", password=PG_PASSWORD, dbname=dbname,
        autocommit=True,
    )


@pytest.fixture(scope="session", autouse=True)
def database() -> Any:
    """Create acme_test if missing, start from an empty schema, then apply schema and seed."""
    with _admin_connect("postgres") as conn:
        found = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DB,)).fetchone()
        if not found:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(TEST_DB)))
    with _admin_connect(TEST_DB) as conn:
        conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
        conn.execute("CREATE SCHEMA public")
    import function
    from acme.core import db

    db.reset_connection()
    db._schema_ready = False
    db.ensure_schema(function.SETTINGS)
    yield function
    db.reset_connection()


@pytest.fixture
def conn(database: Any) -> psycopg.Connection:
    """The handler's own connection (inside the per-test transaction)."""
    from acme.core import db

    return db.get_connection(database.SETTINGS)


@pytest.fixture(autouse=True)
def rollback(request: pytest.FixtureRequest, database: Any) -> Any:
    """Wrap each test in a transaction that is always rolled back."""
    if request.node.get_closest_marker("no_rollback"):
        yield
        return
    from acme.core import db

    connection = db.get_connection(database.SETTINGS)
    with connection.transaction(force_rollback=True):
        yield


def make_event(
    method: str,
    path: str,
    *,
    body: Any = None,
    raw_body: str | None = None,
    query: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    base64_body: bool = False,
) -> dict[str, Any]:
    """Build a Lambda Function URL (payload v2) event."""
    text = raw_body if raw_body is not None else (None if body is None else json.dumps(body))
    if text is not None and base64_body:
        text = base64.b64encode(text.encode("utf-8")).decode("ascii")
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": urlencode(query or {}),
        "headers": {"content-type": "application/json", **(headers or {})},
        "queryStringParameters": {k: str(v) for k, v in query.items()} if query else None,
        "requestContext": {"http": {"method": method, "path": path, "sourceIp": "127.0.0.1"}},
        "body": text,
        "isBase64Encoded": base64_body,
    }


@dataclass
class Result:
    """A decoded handler response."""

    status: int
    body: Any
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def error(self) -> dict[str, Any]:
        """The error object of an error response."""
        return self.body["error"]

    @property
    def fields(self) -> set[str]:
        """Field names listed in the error details."""
        return {detail["field"] for detail in self.body["error"]["details"]}


class Api:
    """Calls ``function.handler`` like a Function URL would, in one path style."""

    def __init__(self, prefix: str, tokens: dict[str, str]) -> None:
        """``prefix`` is "" (local, proxy-stripped) or "/api/tracker" (cloud)."""
        self.prefix = prefix
        self.tokens = tokens

    def call(
        self, method: str, path: str, *, role: str | None = "admin", token: str | None = None,
        **event: Any,
    ) -> Result:
        """Send one request as ``role`` (None: no Authorization header) and decode it."""
        import function

        headers = dict(event.pop("headers", None) or {})
        bearer = token if token is not None else (self.tokens[role] if role else None)
        if bearer is not None:
            headers["authorization"] = f"Bearer {bearer}"
        event_data = make_event(method, self.prefix + path, headers=headers, **event)
        response = function.handler(event_data)
        body = json.loads(response["body"]) if response["body"] else None
        return Result(response["statusCode"], body, response["headers"])

    def get(self, path: str, **kwargs: Any) -> Result:
        """GET request."""
        return self.call("GET", path, **kwargs)

    def post(self, path: str, body: Any = None, **kwargs: Any) -> Result:
        """POST request with a JSON body."""
        return self.call("POST", path, body=body, **kwargs)

    def put(self, path: str, body: Any = None, **kwargs: Any) -> Result:
        """PUT request with a JSON body."""
        return self.call("PUT", path, body=body, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Result:
        """DELETE request."""
        return self.call("DELETE", path, **kwargs)


@pytest.fixture(scope="session")
def tokens(database: Any) -> dict[str, str]:
    """An access token for each seeded demo user, keyed by role."""
    from acme.core import auth, db

    connection = db.get_connection(database.SETTINGS)
    issued = {}
    for role, email in ROLE_EMAILS.items():
        user = connection.execute(
            "SELECT id, email, role, token_version FROM users WHERE email = %s", (email,)
        ).fetchone()
        issued[role] = auth.issue_tokens(user, database.SETTINGS)["access_token"]
    return issued


@pytest.fixture(params=["", CLOUD_PREFIX], ids=["local-path", "cloud-path"])
def api(request: pytest.FixtureRequest, tokens: dict[str, str]) -> Api:
    """An API client; every test using it runs once per path style."""
    return Api(request.param, tokens)


def id_of(conn: psycopg.Connection, table: str, column: str, value: Any) -> int:
    """Look up the id of a seeded row by a natural key."""
    query = sql.SQL("SELECT id FROM {} WHERE {} = %s").format(
        sql.Identifier(table), sql.Identifier(column)
    )
    row = conn.execute(query, (value,)).fetchone()
    if row is None:
        raise LookupError(f"no {table} row with {column} = {value!r}")
    return row["id"]
