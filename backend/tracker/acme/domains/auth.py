"""Login, token refresh, the current user, admin user management and the health check."""

from __future__ import annotations

from typing import Any

from acme.core import auth
from acme.core.crud import Filter, Resource, fetch, register
from acme.core.http import (
    BadRequest,
    Conflict,
    Request,
    Response,
    Router,
    Unauthorized,
    no_content,
    ok,
)
from acme.core.validation import boolean, email, enum, string, validate

PASSWORD_MIN = 8
PASSWORD_MAX = 128

_LOGIN_QUERY = (
    "SELECT id, email, full_name, role, is_active, password_hash FROM users WHERE email = %s"
)
_USER_BY_ID_QUERY = (
    "SELECT id, email, full_name, role, is_active, created_at, updated_at FROM users WHERE id = %s"
)

LOGIN_FIELDS = (
    email("email", required=True),
    string("password", required=True, max_length=PASSWORD_MAX, strip=False),
)
REFRESH_FIELDS = (string("refresh_token", required=True, max_length=4096),)


def _public(user: dict[str, Any]) -> dict[str, Any]:
    """The user fields safe to return: never the password hash."""
    return {key: user[key] for key in ("id", "email", "full_name", "role", "is_active")}


def login(request: Request) -> Response:
    """Exchange email and password for tokens; the same 401 for unknown email or wrong password."""
    credentials = validate(request.body, LOGIN_FIELDS)
    user = request.db.execute(_LOGIN_QUERY, (credentials["email"],)).fetchone()
    if user is None:
        auth.burn_password_check(credentials["password"])
        raise Unauthorized("Email or password is incorrect", code="invalid_credentials")
    if not auth.verify_password(credentials["password"], user["password_hash"]):
        raise Unauthorized("Email or password is incorrect", code="invalid_credentials")
    if not user["is_active"]:
        raise Unauthorized("This account has been deactivated", code="account_inactive")
    return ok({**auth.issue_tokens(user, request.settings), "user": _public(user)})


def refresh(request: Request) -> Response:
    """Exchange a refresh token for new tokens, re-reading the user's role and status."""
    data = validate(request.body, REFRESH_FIELDS)
    claims = auth.decode_token(data["refresh_token"], request.settings, auth.TYP_REFRESH)
    user = request.db.execute(_USER_BY_ID_QUERY, (int(claims["sub"]),)).fetchone()
    if user is None or not user["is_active"]:
        raise Unauthorized("This account no longer exists or is inactive", code="invalid_token")
    return ok({**auth.issue_tokens(user, request.settings), "user": _public(user)})


def me(request: Request) -> Response:
    """Return the authenticated user."""
    user = request.db.execute(_USER_BY_ID_QUERY, (request.user["id"],)).fetchone()
    if user is None:
        raise Unauthorized("This account no longer exists", code="invalid_token")
    return ok(user)


def health(request: Request) -> Response:
    """Public liveness check that also proves the database answers."""
    request.db.execute("SELECT 1")
    return ok({"status": "ok", "database": "ok"})


def _before_save_user(
    request: Request, values: dict[str, Any], existing: dict[str, Any] | None
) -> None:
    """Stop admins locking themselves out, and hash any new password."""
    if existing is not None and existing["id"] == request.user["id"]:
        errors = []
        if "role" in values and values["role"] != existing["role"]:
            errors.append({"field": "role", "message": "you cannot change your own role"})
        if values.get("is_active") is False:
            errors.append({"field": "is_active", "message": "you cannot deactivate yourself"})
        if errors:
            raise BadRequest("Admins cannot demote or deactivate themselves", errors)
    if "password" in values:
        values["password_hash"] = auth.hash_password(values.pop("password"))


USERS = Resource(
    table="users",
    label="user",
    columns=("id", "email", "full_name", "role", "is_active", "created_at", "updated_at"),
    fields=(
        email("email", required=True),
        string("full_name", required=True, max_length=120),
        string(
            "password", required=True, min_length=PASSWORD_MIN, max_length=PASSWORD_MAX,
            strip=False,
        ),
        enum("role", auth.ROLES, required=True),
        boolean("is_active"),
    ),
    filters=(Filter("role", "enum", choices=auth.ROLES), Filter("is_active", "bool")),
    searchable=("email", "full_name"),
    sortable=("email", "full_name", "role", "created_at"),
    default_sort="email",
    before_save=_before_save_user,
    role="admin",
)


def delete_user(request: Request) -> Response:
    """Delete a user who owns nothing; admins cannot delete themselves."""
    user_id = request.params["id"]
    if user_id == request.user["id"]:
        raise BadRequest(
            "Admins cannot delete themselves",
            [{"field": "id", "message": "you cannot delete your own account"}],
        )
    fetch(request.db, USERS, user_id)
    refs = request.db.execute(
        "SELECT (SELECT count(*) FROM projects WHERE owner_id = %s) AS projects, "
        "(SELECT count(*) FROM budget_entries WHERE created_by = %s) AS entries",
        (user_id, user_id),
    ).fetchone()
    if refs["projects"] or refs["entries"]:
        raise Conflict(
            f"User {user_id} owns {refs['projects']} project(s) and recorded "
            f"{refs['entries']} budget entry(ies); deactivate the account instead",
            code="user_in_use",
        )
    request.db.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return no_content()


def register_routes(router: Router) -> None:
    """Add the auth, user-management and health routes."""
    router.add("GET", "/health", health, public=True)
    router.add("POST", "/auth/login", login, public=True)
    router.add("POST", "/auth/refresh", refresh, public=True)
    router.add("GET", "/auth/me", me)
    register(router, "/auth/users", USERS, delete=delete_user)
