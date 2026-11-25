"""Idempotency keys: a POST that carries an ``Idempotency-Key`` header runs at most once."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from psycopg.types.json import Jsonb

from acme.core.http import BadRequest, Conflict, Handler, Request, Response, json_default

if TYPE_CHECKING:
    from typing import Any

HEADER = "idempotency-key"
KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,128}")
RETENTION_HOURS = 24
REPLAY_HEADER = {"Idempotent-Replayed": "true"}

_DELETE_EXPIRED = (
    "DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => %s)"
)
_CLAIM = (
    "INSERT INTO idempotency_keys (key, user_id, method, path) VALUES (%s, %s, %s, %s) "
    "ON CONFLICT (key) DO NOTHING RETURNING key"
)
_READ = "SELECT user_id, method, path, status, response FROM idempotency_keys WHERE key = %s"
_STORE = "UPDATE idempotency_keys SET status = %s, response = %s WHERE key = %s"
_RELEASE = "DELETE FROM idempotency_keys WHERE key = %s"


def _dumps(value: Any) -> str:
    return json.dumps(value, default=json_default)


def run_once(request: Request, handler: Handler) -> Response:
    """Run ``handler`` unless this user already ran this POST with the same key.

    Must be called inside the request's transaction, before the handler has written
    anything:

    - The key is claimed with ``INSERT ... ON CONFLICT DO NOTHING``. While another
      transaction holds the same key uncommitted, that statement waits for it; if it
      commits, this request replays its response, and if it rolls back, this one runs.
    - The status and body are stored in the same transaction as the handler's writes, so
      a failed request (which rolls back) stores nothing and may be retried with its key.
    - The same key on another path, or from another user, is a 409.
    - Keys older than 24 hours are deleted here, on write.

    A request without the header just runs.

    Raises:
        BadRequest: If the header is not 8 to 128 characters of ``A-Z a-z 0-9 _ -``.
        Conflict: ``idempotency_key_reused`` when the key belongs to another request.
    """
    key = request.headers.get(HEADER)
    if key is None:
        return handler(request)
    if not KEY_PATTERN.fullmatch(key):
        message = "must be 8 to 128 characters of A-Z, a-z, 0-9, _ and -"
        raise BadRequest(
            "Invalid Idempotency-Key header", [{"field": "Idempotency-Key", "message": message}]
        )
    conn = request.db
    conn.execute(_DELETE_EXPIRED, (RETENTION_HOURS,))
    claim = (key, request.user["id"], request.method, request.path)
    if conn.execute(_CLAIM, claim).fetchone() is None:
        stored = conn.execute(_READ, (key,)).fetchone()
        if stored is None or (stored["user_id"], stored["method"], stored["path"]) != claim[1:]:
            raise Conflict(
                "This Idempotency-Key was already used for a different request",
                code="idempotency_key_reused",
            )
        return Response(stored["status"], stored["response"], dict(REPLAY_HEADER))
    response = handler(request)
    if response.status >= 400:
        conn.execute(_RELEASE, (key,))
    else:
        body = None if response.body is None else Jsonb(response.body, dumps=_dumps)
        conn.execute(_STORE, (response.status, body, key))
    return response
