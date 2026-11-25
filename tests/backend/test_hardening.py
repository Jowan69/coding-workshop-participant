"""Security properties that hold across the whole API, checked against the real router.

- Every route except the three public ones needs a token, and its role follows one rule.
- No role below admin can change a role, their own included.
- A request that fails part-way leaves no writes behind (one transaction per request).
- No response carries a password hash; malformed input is a 400, never a 500.
"""

from __future__ import annotations

import dataclasses
import json
import re
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from acme.core.crud import create_row
from acme.core.http import ROLE_FOR_METHOD, Conflict
from acme.domains.projects import PROJECTS
from conftest import ROLE_EMAILS, SEED_PASSWORD, id_of

PUBLIC_ROUTES = {("GET", "/health"), ("POST", "/auth/login"), ("POST", "/auth/refresh")}

# Phase 6: the routes whose role is deliberately not the method's default, each by name.
# Signing out and changing your own password are for every signed-in role (B2, B3).
ROLE_EXCEPTIONS = {
    ("POST", "/auth/logout"): "viewer",
    ("POST", "/auth/change-password"): "viewer",
    # People who can edit a project must be able to pick its owner (D4): names only.
    ("GET", "/auth/users/options"): "contributor",
    # Removing a dependency link edits a deliverable and deletes no record (F2).
    ("DELETE", "/deliverables/{id}/dependencies/{depends_on_id}"): "contributor",
}


def _routes():
    import function

    return function.ROUTER.routes


def _concrete(template: str) -> str:
    """A path for a route template, with every {param} set to 1."""
    return re.sub(r"\{\w+\}", "1", template)


def test_only_health_login_and_refresh_are_public() -> None:
    public = {(route.method, route.template) for route in _routes() if route.min_role is None}
    assert public == PUBLIC_ROUTES


def test_every_route_role_follows_the_method_rule() -> None:
    for route in _routes():
        if route.min_role is None:
            continue
        admin_only = route.template.startswith("/auth/users")
        expected = "admin" if admin_only else ROLE_FOR_METHOD[route.method]
        expected = ROLE_EXCEPTIONS.get((route.method, route.template), expected)
        assert route.min_role == expected, f"{route.method} {route.template}"


def test_every_role_exception_names_a_real_route() -> None:
    templates = {(route.method, route.template) for route in _routes()}
    assert set(ROLE_EXCEPTIONS) <= templates


def test_every_private_route_answers_401_without_a_token(api) -> None:
    private = [route for route in _routes() if route.min_role is not None]
    assert len(private) > 40  # guards against the loop silently checking nothing
    for route in private:
        result = api.call(route.method, _concrete(route.template), role=None, body={})
        assert result.status == 401, f"{route.method} {route.template}"
        assert result.error["code"] == "missing_token"


def test_every_route_refuses_roles_below_its_minimum(api) -> None:
    """The role check runs before the handler, so these calls change nothing."""
    checked = 0
    for route in _routes():
        if route.min_role in (None, "viewer"):
            continue
        below = "manager" if route.min_role == "admin" else "viewer"
        result = api.call(route.method, _concrete(route.template), role=below, body={})
        assert result.status == 403, f"{route.method} {route.template} as {below}"
        assert result.error["code"] == "forbidden"
        checked += 1
    assert checked > 20


def test_an_unsigned_token_claiming_admin_is_refused(api) -> None:
    now = datetime.now(timezone.utc)
    claims = {"sub": "1", "role": "admin", "typ": "access", "iat": now,
              "exp": now + timedelta(minutes=5)}
    unsigned = jwt.encode(claims, None, algorithm="none")
    result = api.get("/auth/users", token=unsigned)
    assert result.status == 401
    assert result.error["code"] == "invalid_token"


@pytest.mark.parametrize("role", ["viewer", "contributor", "manager"])
def test_non_admins_cannot_change_their_own_role(api, conn, role: str) -> None:
    own_id = id_of(conn, "users", "email", ROLE_EMAILS[role])
    result = api.put(f"/auth/users/{own_id}", {"role": "admin"}, role=role)
    assert result.status == 403
    stored = conn.execute("SELECT role FROM users WHERE id = %s", (own_id,)).fetchone()["role"]
    assert stored == role


def _replace_handler(monkeypatch, method: str, template: str, handler) -> None:
    import function

    patched = [
        dataclasses.replace(r, handler=handler) if (r.method, r.template) == (method, template)
        else r
        for r in function.ROUTER.routes
    ]
    monkeypatch.setattr(function.ROUTER, "routes", patched)


@pytest.mark.parametrize(
    ("failure", "status"), [(Conflict("stopped after the insert"), 409), (RuntimeError("x"), 500)]
)
def test_a_failed_request_rolls_back_its_earlier_writes(
    api, conn, monkeypatch, failure: Exception, status: int
) -> None:
    def insert_then_fail(request):
        create_row(request, PROJECTS)
        raise failure

    _replace_handler(monkeypatch, "POST", "/projects", insert_then_fail)
    body = {"name": "Half-written", "department": "IT", "start_date": "2026-01-01",
            "end_date": "2026-02-01"}
    assert api.post("/projects", body).status == status
    left = conn.execute("SELECT count(*) AS n FROM projects WHERE name = 'Half-written'")
    assert left.fetchone()["n"] == 0


def test_no_user_response_contains_a_password_hash(api, conn) -> None:
    viewer_id = id_of(conn, "users", "email", ROLE_EMAILS["viewer"])
    login = api.post(
        "/auth/login", {"email": ROLE_EMAILS["admin"], "password": SEED_PASSWORD}, role=None
    )
    new_user = {"email": "hash-check@acme.test", "full_name": "Hash Check",
                "password": "Str0ng-Passw0rd", "role": "viewer"}
    responses = [
        login,
        api.post("/auth/refresh", {"refresh_token": login.body["refresh_token"]}, role=None),
        api.get("/auth/me"),
        api.get("/auth/users"),
        api.get(f"/auth/users/{viewer_id}"),
        api.post("/auth/users", new_user),
        api.put(f"/auth/users/{viewer_id}", {"password": "An0ther-Passw0rd"}),
    ]
    for result in responses:
        assert result.status in (200, 201)
        text = json.dumps(result.body)
        # Phase 6 (B5): the only allowed mention is the flag "must_change_password"
        assert "password" not in text.replace('"must_change_password"', "")
        assert "scrypt$" not in text and "token_version" not in text


@pytest.mark.parametrize(
    "path", ["/projects?limit=²", "/deliverables?project_id=²", "/budgets/summary?project_id=²"]
)
def test_non_ascii_digits_in_the_query_are_a_400(api, path: str) -> None:
    route, _, query = path.partition("?")
    name, _, value = query.partition("=")
    result = api.get(route, role="viewer", query={name: value})
    assert result.status == 400
    assert result.fields == {name}
