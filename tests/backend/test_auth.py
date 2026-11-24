"""Login, refresh, /auth/me, the health check and admin user management."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from acme.core import auth
from conftest import ROLE_EMAILS, SEED_PASSWORD, id_of


def _login(api, email: str, password: str = SEED_PASSWORD):
    return api.post("/auth/login", {"email": email, "password": password}, role=None)


def test_health_needs_no_token(api) -> None:
    result = api.get("/health", role=None)
    assert result.status == 200
    assert result.body == {"status": "ok", "database": "ok"}


@pytest.mark.parametrize("role", list(ROLE_EMAILS))
def test_login_returns_tokens_and_user(api, role: str) -> None:
    result = _login(api, ROLE_EMAILS[role].upper())
    assert result.status == 200
    assert result.body["token_type"] == "Bearer"
    assert result.body["expires_in"] == 1800
    assert result.body["user"]["role"] == role
    assert "password_hash" not in result.body["user"]
    me = api.get("/auth/me", token=result.body["access_token"])
    assert me.status == 200
    assert me.body["email"] == ROLE_EMAILS[role]


def test_wrong_password_and_unknown_email_look_the_same(api) -> None:
    wrong = _login(api, "admin@acme.test", "not-the-password")
    unknown = _login(api, "nobody@acme.test", "not-the-password")
    assert wrong.status == unknown.status == 401
    assert wrong.error == unknown.error
    assert wrong.error["code"] == "invalid_credentials"


def test_login_validates_input(api) -> None:
    result = api.post("/auth/login", {"email": "not-an-email"}, role=None)
    assert result.status == 400
    assert result.fields == {"email", "password"}


def test_inactive_user_cannot_log_in(api, conn) -> None:
    conn.execute("UPDATE users SET is_active = false WHERE email = 'viewer@acme.test'")
    result = _login(api, "viewer@acme.test")
    assert result.status == 401
    assert result.error["code"] == "account_inactive"


def test_refresh_issues_new_tokens(api) -> None:
    tokens = _login(api, "manager@acme.test").body
    result = api.post("/auth/refresh", {"refresh_token": tokens["refresh_token"]}, role=None)
    assert result.status == 200
    assert result.body["user"]["role"] == "manager"
    assert api.get("/auth/me", token=result.body["access_token"]).status == 200


def test_refresh_rereads_role_and_status(api, conn) -> None:
    tokens = _login(api, "lead@acme.test").body
    conn.execute("UPDATE users SET role = 'manager' WHERE email = 'lead@acme.test'")
    refreshed = api.post("/auth/refresh", {"refresh_token": tokens["refresh_token"]}, role=None)
    assert refreshed.body["user"]["role"] == "manager"
    conn.execute("UPDATE users SET is_active = false WHERE email = 'lead@acme.test'")
    refused = api.post("/auth/refresh", {"refresh_token": tokens["refresh_token"]}, role=None)
    assert refused.status == 401


def test_refresh_rejects_access_tokens_and_garbage(api, tokens) -> None:
    assert api.post("/auth/refresh", {"refresh_token": tokens["admin"]}, role=None).status == 401
    assert api.post("/auth/refresh", {"refresh_token": "abc.def.ghi"}, role=None).status == 401
    assert api.post("/auth/refresh", {}, role=None).status == 400


def test_me_requires_a_valid_access_token(api, conn, database) -> None:
    assert api.get("/auth/me", role=None).error["code"] == "missing_token"
    assert api.get("/auth/me", token="garbage").error["code"] == "invalid_token"
    user = conn.execute("SELECT * FROM users WHERE email = 'admin@acme.test'").fetchone()
    an_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    old = auth.issue_tokens(user, database.SETTINGS, now=an_hour_ago)
    expired = api.get("/auth/me", token=old["access_token"])
    assert expired.status == 401
    assert expired.error["code"] == "token_expired"
    refresh_as_access = api.get("/auth/me", token=old["refresh_token"])
    assert refresh_as_access.status == 401


def test_me_for_a_deleted_user(api, conn, database) -> None:
    ghost = auth.issue_tokens({"id": 999999, "role": "viewer", "email": "x@y.z"}, database.SETTINGS)
    assert api.get("/auth/me", token=ghost["access_token"]).status == 401


NEW_USER = {
    "email": "New.Person@ACME.test",
    "full_name": "New Person",
    "password": "Str0ng-Passw0rd",
    "role": "contributor",
}


def test_admin_creates_a_user_who_can_log_in(api) -> None:
    result = api.post("/auth/users", NEW_USER)
    assert result.status == 201
    assert result.body["email"] == "new.person@acme.test"
    assert result.body["is_active"] is True
    assert "password_hash" not in result.body and "password" not in result.body
    assert _login(api, "new.person@acme.test", NEW_USER["password"]).status == 200


def test_duplicate_email_is_a_conflict(api) -> None:
    result = api.post("/auth/users", {**NEW_USER, "email": "ADMIN@acme.test"})
    assert result.status == 409
    assert result.fields == {"email"}


def test_user_validation(api) -> None:
    result = api.post("/auth/users", {"email": "bad", "password": "short", "role": "boss"})
    assert result.status == 400
    assert result.fields == {"email", "full_name", "password", "role"}


def test_user_list_filters_search_and_pagination(api) -> None:
    listed = api.get("/auth/users")
    assert listed.status == 200
    assert listed.body["total"] == 4
    assert all("password_hash" not in user for user in listed.body["items"])
    assert [u["role"] for u in api.get("/auth/users", query={"role": "viewer"}).body["items"]] == [
        "viewer"
    ]
    assert api.get("/auth/users", query={"is_active": "false"}).body["total"] == 0
    assert api.get("/auth/users", query={"q": "okafor"}).body["items"][0]["role"] == "manager"
    page = api.get("/auth/users", query={"limit": 2, "offset": 2, "sort": "-email"}).body
    assert (page["total"], page["limit"], page["offset"], len(page["items"])) == (4, 2, 2, 2)
    assert [u["email"] for u in page["items"]] == ["lead@acme.test", "admin@acme.test"]


def test_admin_updates_role_and_password(api, conn) -> None:
    user_id = id_of(conn, "users", "email", "lead@acme.test")
    result = api.put(f"/auth/users/{user_id}", {"role": "manager", "password": "Brand-New-Pass1"})
    assert result.status == 200
    assert result.body["role"] == "manager"
    assert _login(api, "lead@acme.test", "Brand-New-Pass1").status == 200
    assert _login(api, "lead@acme.test").status == 401


def test_admin_cannot_demote_or_deactivate_themselves(api, conn) -> None:
    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    result = api.put(f"/auth/users/{admin_id}", {"role": "viewer", "is_active": False})
    assert result.status == 400
    assert result.fields == {"role", "is_active"}
    assert api.put(f"/auth/users/{admin_id}", {"full_name": "Renamed"}).status == 200


def test_admin_cannot_delete_themselves(api, conn) -> None:
    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    assert api.delete(f"/auth/users/{admin_id}").status == 400


def test_deleting_a_user_who_owns_records_is_refused(api, conn) -> None:
    manager_id = id_of(conn, "users", "email", "manager@acme.test")
    result = api.delete(f"/auth/users/{manager_id}")
    assert result.status == 409
    assert result.error["code"] == "user_in_use"
    assert "deactivate" in result.error["message"]


def test_admin_deletes_an_unused_user(api, conn) -> None:
    created = api.post("/auth/users", NEW_USER).body
    assert api.delete(f"/auth/users/{created['id']}").status == 204
    assert api.get(f"/auth/users/{created['id']}").status == 404
    assert api.delete(f"/auth/users/{created['id']}").status == 404


@pytest.mark.parametrize("role", ["viewer", "contributor", "manager"])
def test_only_admins_manage_users(api, conn, role: str) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    assert api.get("/auth/users", role=role).status == 403
    assert api.post("/auth/users", NEW_USER, role=role).status == 403
    assert api.put(f"/auth/users/{viewer_id}", {"role": "admin"}, role=role).status == 403
    assert api.delete(f"/auth/users/{viewer_id}", role=role).status == 403
    assert api.get("/auth/users", role=None).status == 401
