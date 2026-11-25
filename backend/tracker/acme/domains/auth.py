"""Login, token refresh, sign-out, passwords, admin user management and the health check."""

from __future__ import annotations

import math
from typing import Any

from psycopg import sql

from acme.core import auth
from acme.core.crud import Filter, Resource, fetch, register
from acme.core.http import (
    BadRequest,
    Conflict,
    Request,
    Response,
    Router,
    Unauthorized,
    error_body,
    no_content,
    ok,
)
from acme.core.passwords import PASSWORD_MAX, password_problem
from acme.core.validation import FieldError, boolean, email, enum, string, validate

# Sanity cap on any password field; the policy (10 to 128) is in acme.core.passwords
_PASSWORD_FIELD_MAX = 1024

# Login throttling, per submitted email
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_MINUTES = 15
LOGIN_ATTEMPT_RETENTION_HOURS = 24

_LOGIN_QUERY = (
    "SELECT id, email, full_name, role, is_active, must_change_password, token_version, "
    "password_hash FROM users WHERE email = %s"
)
_USER_BY_ID_QUERY = (
    "SELECT id, email, full_name, role, is_active, must_change_password, token_version, "
    "created_at, updated_at FROM users WHERE id = %s"
)
_OWN_HASH_QUERY = (
    "SELECT id, email, full_name, password_hash FROM users WHERE id = %s FOR UPDATE"
)
_REPLACE_OWN_HASH_QUERY = (
    "UPDATE users SET password_hash = %s, token_version = token_version + 1, "
    "must_change_password = false, updated_at = clock_timestamp() WHERE id = %s "
    "RETURNING id, email, full_name, role, is_active, must_change_password, token_version"
)
# The newest failures inside the window; five of them lock the email until the oldest of
# those five is older than the window.
_LOCKOUT_QUERY = """
SELECT count(*) AS failures,
       ceil(extract(epoch FROM min(attempted_at) + make_interval(mins => %(window)s) - now()))
           AS retry_after
FROM (
    SELECT attempted_at FROM login_attempts
    WHERE email = %(email)s AND attempted_at > now() - make_interval(mins => %(window)s)
    ORDER BY attempted_at DESC
    LIMIT %(limit)s
) recent
"""

LOGIN_FIELDS = (
    email("email", required=True),
    string("password", required=True, max_length=PASSWORD_MAX, strip=False),
)
REFRESH_FIELDS = (string("refresh_token", required=True, max_length=4096),)
CHANGE_PASSWORD_FIELDS = (
    string("current_password", required=True, max_length=_PASSWORD_FIELD_MAX, strip=False),
    string("new_password", required=True, max_length=_PASSWORD_FIELD_MAX, strip=False),
)

_PUBLIC_USER_KEYS = ("id", "email", "full_name", "role", "is_active", "must_change_password")


def _public(user: dict[str, Any]) -> dict[str, Any]:
    """The user fields safe to return: never the password hash or the token version."""
    return {key: user[key] for key in _PUBLIC_USER_KEYS}


def _session(request: Request, user: dict[str, Any]) -> dict[str, Any]:
    """Fresh tokens plus the user they belong to, as login, refresh and change-password return."""
    return {**auth.issue_tokens(user, request.settings), "user": _public(user)}


def _lockout_seconds(request: Request, address: str) -> int:
    """Seconds until ``address`` may try to sign in again; 0 when it is not locked."""
    row = request.db.execute(
        _LOCKOUT_QUERY,
        {"email": address, "window": LOGIN_WINDOW_MINUTES, "limit": LOGIN_MAX_FAILURES},
    ).fetchone()
    if row["failures"] < LOGIN_MAX_FAILURES:
        return 0
    return max(1, int(row["retry_after"]))


def _too_many_attempts(retry_after: int) -> Response:
    minutes = math.ceil(retry_after / 60)
    unit = "minute" if minutes == 1 else "minutes"
    return Response(
        429,
        error_body("too_many_attempts", f"Too many attempts. Try again in {minutes} {unit}."),
        {"Retry-After": str(retry_after)},
    )


def _failed_login(request: Request, address: str, code: str, message: str) -> Response:
    """Record the failure and answer 401.

    The response is returned, not raised: raising would roll the request's transaction
    back and take the recorded attempt with it.
    """
    request.db.execute(
        "DELETE FROM login_attempts WHERE attempted_at < now() - make_interval(hours => %s)",
        (LOGIN_ATTEMPT_RETENTION_HOURS,),
    )
    request.db.execute("INSERT INTO login_attempts (email) VALUES (%s)", (address,))
    return Response(401, error_body(code, message))


def login(request: Request) -> Response:
    """Exchange email and password for tokens.

    An unknown email and a wrong password get the same 401. After five failures for an
    email within fifteen minutes every attempt for it answers 429 with ``Retry-After``,
    whether or not the account exists or the password is right. A success clears the
    email's failures.
    """
    credentials = validate(request.body, LOGIN_FIELDS)
    address = credentials["email"]
    retry_after = _lockout_seconds(request, address)
    if retry_after:
        return _too_many_attempts(retry_after)
    wrong = ("invalid_credentials", "Email or password is incorrect")
    user = request.db.execute(_LOGIN_QUERY, (address,)).fetchone()
    if user is None:
        auth.burn_password_check(credentials["password"])
        return _failed_login(request, address, *wrong)
    if not auth.verify_password(credentials["password"], user["password_hash"]):
        return _failed_login(request, address, *wrong)
    if not user["is_active"]:
        return _failed_login(
            request, address, "account_inactive", "This account has been deactivated"
        )
    request.db.execute("DELETE FROM login_attempts WHERE email = %s", (address,))
    return ok(_session(request, user))


def refresh(request: Request) -> Response:
    """Exchange a refresh token for new tokens, re-reading the user's role and status.

    A user who must change a temporary password gets 403 ``password_change_required``:
    this route is public, so the dispatcher's check never sees it, and a refresh token
    must not be a way to keep a session going without changing the password.
    """
    data = validate(request.body, REFRESH_FIELDS)
    claims = auth.decode_token(data["refresh_token"], request.settings, auth.TYP_REFRESH)
    user = request.db.execute(_USER_BY_ID_QUERY, (int(claims["sub"]),)).fetchone()
    if user is None or not user["is_active"]:
        raise Unauthorized("This account no longer exists or is inactive", code="invalid_token")
    if claims["ver"] != user["token_version"]:
        raise Unauthorized("This session has ended. Sign in again.", code="token_revoked")
    auth.require_password_changed(user, request.method, "/auth/refresh")
    return ok(_session(request, user))


def logout(request: Request) -> Response:
    """Sign the caller out everywhere: every token issued to them so far stops working."""
    request.db.execute(
        "UPDATE users SET token_version = token_version + 1 WHERE id = %s", (request.user["id"],)
    )
    return no_content()


def change_password(request: Request) -> Response:
    """Replace the caller's own password and return fresh tokens.

    The old tokens are revoked (other devices are signed out) and the temporary-password
    flag is cleared; the new tokens keep this caller signed in.
    """
    data = validate(request.body, CHANGE_PASSWORD_FIELDS)
    user = request.db.execute(_OWN_HASH_QUERY, (request.user["id"],)).fetchone()
    if user is None:
        # Deleted after this request was authenticated and before the row was locked
        raise Unauthorized("This account no longer exists", code="invalid_token")
    if not auth.verify_password(data["current_password"], user["password_hash"]):
        raise BadRequest(
            "Validation failed",
            [{"field": "current_password", "message": "is incorrect"}],
        )
    new_password = data["new_password"]
    problem = password_problem(new_password, email=user["email"], full_name=user["full_name"])
    if problem is None and new_password == data["current_password"]:
        problem = "must be different from your current password"
    if problem:
        raise BadRequest("Validation failed", [{"field": "new_password", "message": problem}])
    updated = request.db.execute(
        _REPLACE_OWN_HASH_QUERY, (auth.hash_password(new_password), user["id"])
    ).fetchone()
    return ok(_session(request, updated))


def me(request: Request) -> Response:
    """Return the authenticated user."""
    user = request.db.execute(_USER_BY_ID_QUERY, (request.user["id"],)).fetchone()
    if user is None:
        raise Unauthorized("This account no longer exists", code="invalid_token")
    user.pop("token_version")
    return ok(user)


def health(request: Request) -> Response:
    """Public liveness check that also proves the database answers."""
    request.db.execute("SELECT 1")
    return ok({"status": "ok", "database": "ok"})


def _password_follows_policy(record: dict[str, Any]) -> list[FieldError]:
    """Record-level check: a password being set must satisfy the policy for this account."""
    password = record.get("password")
    if not isinstance(password, str):
        return []
    problem = password_problem(
        password, email=record.get("email"), full_name=record.get("full_name")
    )
    return [{"field": "password", "message": problem}] if problem else []


def _before_save_user(
    request: Request, values: dict[str, Any], existing: dict[str, Any] | None
) -> None:
    """Stop admins locking themselves out, hash any new password and revoke stale sessions.

    On an existing account a new password is an admin reset: it is temporary, so the
    person must change it at their next sign-in. A reset, a role change and a deactivation
    each bump ``token_version``, which ends every session of that person at once.
    """
    if existing is not None and existing["id"] == request.user["id"]:
        errors = []
        if "role" in values and values["role"] != existing["role"]:
            errors.append({"field": "role", "message": "you cannot change your own role"})
        if values.get("is_active") is False:
            errors.append({"field": "is_active", "message": "you cannot deactivate yourself"})
        if errors:
            raise BadRequest("Admins cannot demote or deactivate themselves", errors)
    reset = "password" in values and existing is not None
    if "password" in values:
        values["password_hash"] = auth.hash_password(values.pop("password"))
    if existing is None:
        return
    if reset:
        values["must_change_password"] = True
    role_changed = "role" in values and values["role"] != existing["role"]
    deactivated = values.get("is_active") is False and existing["is_active"]
    if reset or role_changed or deactivated:
        values["token_version"] = existing["token_version"] + 1


USERS = Resource(
    table="users",
    label="user",
    columns=(
        "id", "email", "full_name", "role", "is_active", "must_change_password", "created_at",
        "updated_at",
    ),
    fields=(
        email("email", required=True),
        string("full_name", required=True, max_length=120),
        string("password", required=True, max_length=_PASSWORD_FIELD_MAX, strip=False),
        enum("role", auth.ROLES, required=True),
        boolean("is_active"),
    ),
    filters=(Filter("role", "enum", choices=auth.ROLES), Filter("is_active", "bool")),
    searchable=("email", "full_name"),
    sortable=("email", "full_name", "role", "created_at"),
    default_sort="email",
    checks=(_password_follows_policy,),
    before_save=_before_save_user,
    role="admin",
    # Whether sign-in is throttled for this account right now, so an admin can unlock it
    extra_select=sql.SQL(
        "(SELECT count(*) >= {limit} FROM login_attempts la WHERE la.email = t.email "
        "AND la.attempted_at > now() - make_interval(mins => {window})) AS is_locked"
    ).format(limit=sql.Literal(LOGIN_MAX_FAILURES), window=sql.Literal(LOGIN_WINDOW_MINUTES)),
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


def unlock_user(request: Request) -> Response:
    """Lift a sign-in lockout by forgetting the account's failed attempts."""
    user = fetch(request.db, USERS, request.params["id"])
    request.db.execute("DELETE FROM login_attempts WHERE email = %s", (user["email"],))
    return no_content()


def user_options(request: Request) -> Response:
    """Id and name of every active user, for pickers such as a project's owner.

    Open to contributors and above (only admins can read ``/auth/users``): it returns
    nothing but names, and people who can edit a project need to be able to name its owner.
    """
    items = request.db.execute(
        "SELECT id, full_name FROM users WHERE is_active ORDER BY full_name, id"
    ).fetchall()
    return ok({"items": items, "total": len(items), "limit": len(items), "offset": 0})


def register_routes(router: Router) -> None:
    """Add the auth, user-management and health routes."""
    router.add("GET", "/health", health, public=True)
    router.add("POST", "/auth/login", login, public=True, idempotent=False)
    router.add("POST", "/auth/refresh", refresh, public=True, idempotent=False)
    router.add("GET", "/auth/me", me)
    # Every signed-in role manages its own session and password (the POST default is
    # contributor, which would shut viewers out). Their responses are never stored for
    # replay: one of them carries tokens.
    router.add("POST", "/auth/logout", logout, role="viewer", idempotent=False)
    router.add("POST", "/auth/change-password", change_password, role="viewer", idempotent=False)
    router.add("GET", "/auth/users/options", user_options, role="contributor")
    register(router, "/auth/users", USERS, delete=delete_user)
    router.add("DELETE", "/auth/users/{id}/lockout", unlock_user, role="admin")
