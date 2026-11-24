"""HTTP layer: Function URL events in, JSON responses out, routing and the request pipeline."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any
from urllib.parse import parse_qsl

from psycopg import errors as pg_errors

if TYPE_CHECKING:
    import psycopg

    from acme.core.config import Settings

logger = logging.getLogger("acme.http")

API_PREFIX = "/api/tracker"

# Minimum role per HTTP method (CLAUDE.md); a route may override it (/auth/users: admin)
ROLE_FOR_METHOD = {
    "GET": "viewer",
    "POST": "contributor",
    "PUT": "contributor",
    "DELETE": "manager",
}


class ApiError(Exception):
    """An error whose status, code and message are safe to return to the client."""

    status = 500
    code = "internal_error"

    def __init__(
        self, message: str, details: list[dict[str, str]] | None = None, code: str | None = None
    ) -> None:
        """Create the error; ``details`` lists per-field problems."""
        super().__init__(message)
        self.message = message
        self.details = details or []
        if code:
            self.code = code


class BadRequest(ApiError):
    """400: validation failed or the request is malformed."""

    status = 400
    code = "validation_error"


class Unauthorized(ApiError):
    """401: missing, invalid or expired credentials."""

    status = 401
    code = "unauthorized"


class Forbidden(ApiError):
    """403: authenticated, but the role is not allowed to do this."""

    status = 403
    code = "forbidden"


class NotFound(ApiError):
    """404: no such route or record."""

    status = 404
    code = "not_found"


class Conflict(ApiError):
    """409: duplicate or conflicting state."""

    status = 409
    code = "conflict"


def error_body(code: str, message: str, details: list[dict[str, str]] | None = None) -> dict:
    """Return the error envelope every failed response uses."""
    return {"error": {"code": code, "message": message, "details": details or []}}


@dataclass
class Request:
    """One parsed request, enriched by dispatch() with the user, settings and connection."""

    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    body: Any = None
    params: dict[str, int] = field(default_factory=dict)
    user: dict[str, Any] | None = None
    settings: Settings | None = None
    db: psycopg.Connection | None = None


@dataclass
class Response:
    """A JSON response before it is encoded for Lambda."""

    status: int
    body: Any = None


def ok(body: Any) -> Response:
    """200 with a JSON body."""
    return Response(200, body)


def created(body: Any) -> Response:
    """201 with the created resource."""
    return Response(201, body)


def no_content() -> Response:
    """204 with an empty body."""
    return Response(204)


def strip_prefix(path: str) -> str:
    """Remove the cloud prefix ``/api/tracker`` so both path styles route the same way."""
    if path == API_PREFIX or path.startswith(API_PREFIX + "/"):
        path = path[len(API_PREFIX) :]
    return path or "/"


def parse_event(event: dict[str, Any]) -> Request:
    """Turn a Function URL (payload v2) event into a Request.

    Raises:
        BadRequest: If the body is not valid base64 or not valid JSON.
    """
    method, raw_path = _method_and_path(event)
    headers = {str(key).lower(): str(value) for key, value in (event.get("headers") or {}).items()}
    return Request(
        method=method,
        path=strip_prefix(raw_path),
        query=_parse_query(event),
        headers=headers,
        body=_parse_body(event),
    )


def _method_and_path(event: dict[str, Any]) -> tuple[str, str]:
    http = (event.get("requestContext") or {}).get("http") or {}
    method = str(http.get("method") or "GET").upper()
    path = str(event.get("rawPath") or http.get("path") or "/")
    return method, path


def _parse_query(event: dict[str, Any]) -> dict[str, str]:
    raw = event.get("rawQueryString")
    if raw:
        query: dict[str, str] = {}
        for key, value in parse_qsl(raw, keep_blank_values=True):
            query.setdefault(key, value)
        return query
    return {str(k): str(v) for k, v in (event.get("queryStringParameters") or {}).items()}


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not allowed")


def _parse_body(event: dict[str, Any]) -> Any:
    raw = event.get("body")
    if not raw:
        return None
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as exc:
            raise BadRequest(
                "Request body is not valid base64-encoded UTF-8", code="malformed_body"
            ) from exc
    if not raw.strip():
        return None
    try:
        return json.loads(raw, parse_float=Decimal, parse_constant=_reject_constant)
    except ValueError as exc:
        reason = exc.msg if isinstance(exc, json.JSONDecodeError) else str(exc)
        message = f"Request body is not valid JSON: {reason}"
        raise BadRequest(message, code="malformed_json") from exc


Handler = Callable[[Request], Response]


@dataclass(frozen=True)
class Route:
    """A method and path template bound to a handler and the minimum role it needs."""

    method: str
    template: str
    pattern: re.Pattern[str]
    handler: Handler
    min_role: str | None  # None means public


class Router:
    """Matches method and path to a Route; ``{name}`` segments capture positive integers."""

    def __init__(self) -> None:
        """Create an empty router."""
        self.routes: list[Route] = []

    def add(
        self,
        method: str,
        template: str,
        handler: Handler,
        *,
        role: str | None = None,
        public: bool = False,
    ) -> None:
        """Register a route; the role defaults from the method unless ``public`` is set."""
        method = method.upper()
        min_role = None if public else (role or ROLE_FOR_METHOD[method])
        self.routes.append(Route(method, template, _compile(template), handler, min_role))

    def match(self, method: str, path: str) -> tuple[Route, dict[str, int]] | None:
        """Return the first route matching method and path, with its integer params."""
        for route in self.routes:
            if route.method != method:
                continue
            found = route.pattern.match(path)
            if found:
                return route, {key: int(value) for key, value in found.groupdict().items()}
        return None


def _compile(template: str) -> re.Pattern[str]:
    parts = []
    for segment in template.strip("/").split("/"):
        param = re.fullmatch(r"\{(\w+)\}", segment)
        parts.append(f"(?P<{param.group(1)}>[0-9]{{1,18}})" if param else re.escape(segment))
    return re.compile("^/" + "/".join(parts) + "/?$")


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def to_lambda(response: Response) -> dict[str, Any]:
    """Encode a Response in the shape a Function URL expects."""
    headers = {"Content-Type": "application/json"}
    if response.status == 204:
        return {"statusCode": 204, "headers": headers, "body": ""}
    body = json.dumps(response.body, default=_json_default)
    return {"statusCode": response.status, "headers": headers, "body": body}


def _from_database_error(exc: Exception, method: str) -> Response | None:
    """Map integrity and data errors that slipped past validation to client errors."""
    if isinstance(exc, pg_errors.UniqueViolation):
        table = exc.diag.table_name or ""
        constraint = exc.diag.constraint_name or ""
        if constraint.endswith("_key"):
            column = constraint.removeprefix(table + "_").removesuffix("_key")
            details = [{"field": column, "message": "already exists"}]
            message = f"That {column} is already in use"
            return Response(409, error_body("duplicate", message, details))
        return Response(409, error_body("duplicate", "This record already exists"))
    if isinstance(exc, pg_errors.ForeignKeyViolation):
        if method == "DELETE":
            message = "Other records still reference this one; remove or reassign them first"
            return Response(409, error_body("conflict", message))
        return Response(400, error_body("validation_error", "A referenced record does not exist"))
    if isinstance(exc, (pg_errors.IntegrityError, pg_errors.DataError)):
        return Response(400, error_body("validation_error", "A value is invalid or out of range"))
    return None


def dispatch(event: dict[str, Any], router: Router, settings: Settings) -> dict[str, Any]:
    """Run one request through the pipeline and return the Function URL response.

    Order: parse, ensure the schema, match the route, authenticate (unless the route is
    public), check the role, then run the handler inside one database transaction.
    Unknown paths answer 401 without a valid token and 404 with one. Every request logs
    one line: method, path, status, duration and user id.
    """
    # Imported here because auth and db (via the seed) import this module's error classes.
    from acme.core import auth, db

    started = time.perf_counter()
    method, raw_path = _method_and_path(event)
    user_id: int | None = None
    try:
        request = parse_event(event)
        request.settings = settings
        db.ensure_schema(settings)
        match = router.match(request.method, request.path)
        if match is None or match[0].min_role is not None:
            request.user = auth.authenticate(request.headers, settings)
            user_id = request.user["id"]
        if match is None:
            raise NotFound(f"No route for {request.method} {request.path}", code="route_not_found")
        route, request.params = match
        if route.min_role is not None:
            auth.require_role(request, route.min_role)

        def work(conn: psycopg.Connection) -> Response:
            request.db = conn
            return route.handler(request)

        response = db.run_with_retry(settings, work)
    except ApiError as exc:
        response = Response(exc.status, error_body(exc.code, exc.message, exc.details))
    except Exception as exc:
        response = _from_database_error(exc, method)
        if response is None:
            logger.exception("unhandled error on %s %s", method, raw_path)
            response = Response(500, error_body("internal_error", "Internal server error"))
    duration_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "method=%s path=%s status=%d duration_ms=%.1f user_id=%s",
        method,
        raw_path,
        response.status,
        duration_ms,
        "-" if user_id is None else user_id,
    )
    return to_lambda(response)
