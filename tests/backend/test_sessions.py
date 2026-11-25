"""Phase 6, part B: live roles, revocation, sign-out, passwords and login throttling."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

import jwt
import pytest

from acme.core import auth
from acme.core.passwords import COMMON_PASSWORDS, PASSWORD_MAX, PASSWORD_MIN, password_problem
from acme.domains import auth as auth_domain
from conftest import PG_PASSWORD, ROLE_EMAILS, SEED_PASSWORD, TEST_DB, id_of, make_event

GOOD_PASSWORD = "Tangerine-Sky-42"
ANOTHER_PASSWORD = "Maple-Harbour-77"
ALLOWED_WHILE_PASSWORD_IS_TEMPORARY = {
    ("GET", "/auth/me"), ("POST", "/auth/change-password"), ("POST", "/auth/logout"),
}
EMAIL_NAME_PROBLEM = "must not contain the email name (the part before the @)"
PERSON_NAME_PROBLEM = "must not contain the person's name"


def _login(api, email: str, password: str = SEED_PASSWORD):
    return api.post("/auth/login", {"email": email, "password": password}, role=None)


def _session(api, role: str) -> dict:
    result = _login(api, ROLE_EMAILS[role])
    assert result.status == 200
    return result.body


def _claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False})


def _version(conn, email: str) -> int:
    return conn.execute(
        "SELECT token_version FROM users WHERE email = %s", (email,)
    ).fetchone()["token_version"]


def _concrete(template: str) -> str:
    return re.sub(r"\{\w+\}", "1", template)


# B1: the database decides who the caller is, on every request


def test_a_demoted_user_is_held_to_the_new_role_at_once(api, conn) -> None:
    token = _session(api, "manager")["access_token"]
    project = {"name": "Before demotion", "department": "IT", "start_date": "2026-01-01",
               "end_date": "2026-02-01"}
    assert api.post("/projects", project, token=token).status == 201
    conn.execute("UPDATE users SET role = 'viewer' WHERE email = 'manager@acme.test'")
    refused = api.post("/projects", {**project, "name": "After demotion"}, token=token)
    assert refused.status == 403
    assert refused.error["code"] == "forbidden"
    assert api.get("/projects", token=token).status == 200


def test_a_promoted_user_gains_the_new_role_at_once(api, conn) -> None:
    token = _session(api, "viewer")["access_token"]
    assert api.get("/auth/users", token=token).status == 403
    conn.execute("UPDATE users SET role = 'admin' WHERE email = 'viewer@acme.test'")
    assert api.get("/auth/users", token=token).status == 200


def test_a_deactivated_users_valid_token_gets_401(api, conn) -> None:
    token = _session(api, "contributor")["access_token"]
    assert api.get("/projects", token=token).status == 200
    conn.execute("UPDATE users SET is_active = false WHERE email = 'lead@acme.test'")
    for path in ("/projects", "/auth/me", "/insights/summary"):
        result = api.get(path, token=token)
        assert result.status == 401, path
        assert result.error["code"] == "invalid_token"


def test_a_deleted_users_valid_token_gets_401(api, conn) -> None:
    created = api.post("/auth/users", {"email": "gone@acme.test", "full_name": "Gone Soon",
                                       "password": GOOD_PASSWORD, "role": "manager"})
    assert created.status == 201
    token = _login(api, "gone@acme.test", GOOD_PASSWORD).body["access_token"]
    assert api.get("/projects", token=token).status == 200
    conn.execute("DELETE FROM users WHERE email = 'gone@acme.test'")
    result = api.get("/projects", token=token)
    assert result.status == 401
    assert result.error["code"] == "invalid_token"


def test_the_role_claim_in_a_token_is_ignored(api, conn, database) -> None:
    viewer = conn.execute("SELECT * FROM users WHERE email = 'viewer@acme.test'").fetchone()
    forged_role = auth.issue_tokens({**viewer, "role": "admin"}, database.SETTINGS)
    assert _claims(forged_role["access_token"])["role"] == "admin"
    assert api.get("/auth/users", token=forged_role["access_token"]).status == 403


def test_authentication_reads_the_user_with_one_primary_key_query(conn) -> None:
    class Counting:
        def __init__(self) -> None:
            self.queries: list[str] = []

        def execute(self, query, params=None):
            self.queries.append(query)
            return conn.execute(query, params)

    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    counting = Counting()
    user = auth.current_user(counting, {"id": admin_id, "ver": 0})
    assert user == {"id": admin_id, "role": "admin", "email": "admin@acme.test",
                    "must_change_password": False}
    assert len(counting.queries) == 1
    conn.execute("SET LOCAL enable_seqscan = off")
    plan = conn.execute("EXPLAIN " + counting.queries[0], (admin_id,)).fetchall()
    assert "users_pkey" in json.dumps(plan)


# B2: revocation through token_version


def test_both_tokens_carry_the_users_token_version(api, conn) -> None:
    conn.execute("UPDATE users SET token_version = 7 WHERE email = 'viewer@acme.test'")
    session = _session(api, "viewer")
    assert _claims(session["access_token"])["ver"] == 7
    assert _claims(session["refresh_token"])["ver"] == 7


@pytest.mark.parametrize("typ", ["access", "refresh"])
def test_tokens_without_a_version_are_refused(api, conn, database, typ: str) -> None:
    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    now = datetime.now(timezone.utc)
    claims = {"sub": str(admin_id), "role": "admin", "typ": typ, "iat": now,
              "exp": now + timedelta(minutes=5)}
    old_style = jwt.encode(claims, database.SETTINGS.jwt_secret, algorithm="HS256")
    if typ == "access":
        result = api.get("/auth/me", token=old_style)
    else:
        result = api.post("/auth/refresh", {"refresh_token": old_style}, role=None)
    assert result.status == 401
    assert result.error["code"] == "invalid_token"


@pytest.mark.parametrize("version", ["0", 0.5, True, None])
def test_a_version_that_is_not_an_integer_is_refused(api, conn, database, version) -> None:
    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    now = datetime.now(timezone.utc)
    claims = {"sub": str(admin_id), "role": "admin", "typ": "access", "ver": version,
              "iat": now, "exp": now + timedelta(minutes=5)}
    token = jwt.encode(claims, database.SETTINGS.jwt_secret, algorithm="HS256")
    result = api.get("/auth/me", token=token)
    assert result.status == 401
    assert result.error["code"] == "invalid_token"


def _assert_revoked(api, session: dict) -> None:
    refused = api.get("/auth/me", token=session["access_token"])
    assert refused.status == 401
    assert refused.error["code"] == "token_revoked"
    refresh = api.post("/auth/refresh", {"refresh_token": session["refresh_token"]}, role=None)
    assert refresh.status == 401
    assert refresh.error["code"] == "token_revoked"


@pytest.mark.parametrize(
    "change",
    [{"password": GOOD_PASSWORD}, {"role": "viewer"}, {"is_active": False}],
    ids=["admin-reset", "role-change", "deactivation"],
)
def test_an_admin_change_revokes_that_users_tokens(api, conn, change: dict) -> None:
    session = _session(api, "contributor")
    lead_id = id_of(conn, "users", "email", "lead@acme.test")
    before = _version(conn, "lead@acme.test")
    assert api.put(f"/auth/users/{lead_id}", change).status == 200
    assert _version(conn, "lead@acme.test") == before + 1
    if change.get("is_active") is False:
        refused = api.get("/auth/me", token=session["access_token"])
        assert refused.status == 401
    else:
        _assert_revoked(api, session)


@pytest.mark.parametrize(
    "change", [{"full_name": "Maria G."}, {"role": "contributor"}, {"is_active": True}],
    ids=["rename", "same-role", "still-active"],
)
def test_changes_that_do_not_affect_access_keep_the_session(api, conn, change: dict) -> None:
    session = _session(api, "contributor")
    lead_id = id_of(conn, "users", "email", "lead@acme.test")
    before = _version(conn, "lead@acme.test")
    assert api.put(f"/auth/users/{lead_id}", change).status == 200
    assert _version(conn, "lead@acme.test") == before
    assert api.get("/auth/me", token=session["access_token"]).status == 200


@pytest.mark.parametrize("role", list(ROLE_EMAILS))
def test_logout_ends_every_session_of_the_caller(api, role: str) -> None:
    laptop, phone = _session(api, role), _session(api, role)
    result = api.post("/auth/logout", token=laptop["access_token"])
    assert result.status == 204
    assert result.body is None
    _assert_revoked(api, laptop)
    _assert_revoked(api, phone)
    assert _login(api, ROLE_EMAILS[role]).status == 200


def test_logout_leaves_other_users_signed_in(api) -> None:
    viewer, manager = _session(api, "viewer"), _session(api, "manager")
    assert api.post("/auth/logout", token=viewer["access_token"]).status == 204
    assert api.get("/auth/me", token=manager["access_token"]).status == 200


def test_logout_needs_a_token(api) -> None:
    result = api.post("/auth/logout", role=None)
    assert result.status == 401
    assert result.error["code"] == "missing_token"


# B3: changing your own password


@pytest.mark.parametrize("role", list(ROLE_EMAILS))
def test_every_role_can_change_its_own_password(api, role: str) -> None:
    email = ROLE_EMAILS[role]
    old, other_device = _session(api, role), _session(api, role)
    result = api.post(
        "/auth/change-password",
        {"current_password": SEED_PASSWORD, "new_password": GOOD_PASSWORD},
        token=old["access_token"],
    )
    assert result.status == 200
    assert set(result.body) == {"access_token", "refresh_token", "token_type", "expires_in", "user"}
    assert result.body["user"]["email"] == email
    assert result.body["user"]["must_change_password"] is False
    # the caller stays signed in with the fresh tokens; every older token is revoked
    assert api.get("/auth/me", token=result.body["access_token"]).status == 200
    refreshed = api.post(
        "/auth/refresh", {"refresh_token": result.body["refresh_token"]}, role=None
    )
    assert refreshed.status == 200
    _assert_revoked(api, old)
    _assert_revoked(api, other_device)
    assert _login(api, email, GOOD_PASSWORD).status == 200
    assert _login(api, email, SEED_PASSWORD).status == 401


def test_a_wrong_current_password_is_a_field_error(api, conn) -> None:
    before = _version(conn, "viewer@acme.test")
    result = api.post(
        "/auth/change-password",
        {"current_password": "not-my-password", "new_password": GOOD_PASSWORD}, role="viewer",
    )
    assert result.status == 400
    assert result.error["code"] == "validation_error"
    assert result.error["details"] == [
        {"field": "current_password", "message": "is incorrect"}
    ]
    assert _version(conn, "viewer@acme.test") == before
    assert _login(api, "viewer@acme.test").status == 200


def test_change_password_requires_both_fields(api) -> None:
    result = api.post("/auth/change-password", {}, role="viewer")
    assert result.status == 400
    assert result.fields == {"current_password", "new_password"}


def test_the_new_password_must_differ_and_follow_the_policy(api) -> None:
    same = api.post(
        "/auth/change-password",
        {"current_password": SEED_PASSWORD, "new_password": SEED_PASSWORD}, role="viewer",
    )
    assert same.status == 400
    assert same.error["details"] == [
        {"field": "new_password", "message": "must be different from your current password"}
    ]
    weak = api.post(
        "/auth/change-password",
        {"current_password": SEED_PASSWORD, "new_password": "short1"}, role="viewer",
    )
    assert weak.status == 400
    assert weak.error["details"] == [
        {"field": "new_password", "message": "must be at least 10 characters"}
    ]
    named = api.post(
        "/auth/change-password",
        {"current_password": SEED_PASSWORD, "new_password": "xx-Tom Becker-2026"}, role="viewer",
    )
    assert named.error["details"][0]["message"] == "must not contain the person's name"


def test_change_password_needs_a_token(api) -> None:
    body = {"current_password": SEED_PASSWORD, "new_password": GOOD_PASSWORD}
    assert api.post("/auth/change-password", body, role=None).status == 401


def test_change_password_for_a_user_deleted_mid_request_is_a_401(api, conn, monkeypatch) -> None:
    """The row can go between authentication and the handler's locked read: 401, never 500."""
    created = api.post("/auth/users", {"email": "vanishing@acme.test", "full_name": "Vanishing Act",
                                       "password": GOOD_PASSWORD, "role": "viewer"})
    assert created.status == 201
    token = _login(api, "vanishing@acme.test", GOOD_PASSWORD).body["access_token"]
    authenticate = auth.current_user
    deleted = []

    def authenticate_then_delete(connection, identity):
        user = authenticate(connection, identity)
        connection.execute("DELETE FROM users WHERE id = %s", (user["id"],))
        deleted.append(user["id"])
        return user

    monkeypatch.setattr(auth, "current_user", authenticate_then_delete)
    result = api.post(
        "/auth/change-password",
        {"current_password": GOOD_PASSWORD, "new_password": ANOTHER_PASSWORD}, token=token,
    )
    assert deleted == [created.body["id"]]
    assert result.status == 401
    assert result.error == {
        "code": "invalid_token", "message": "This account no longer exists", "details": [],
    }


# B4: one password policy


@pytest.mark.parametrize(
    ("password", "problem"),
    [
        ("Short-1", f"must be at least {PASSWORD_MIN} characters"),
        ("a1" * 65, f"must be at most {PASSWORD_MAX} characters"),
        ("1234567890-!", "must contain at least one letter"),
        ("no-digits-here", "must contain at least one digit"),
        ("my-Pat.Lee-2026", "must not contain the email name (the part before the @)"),
        ("2026 patricia lee!", "must not contain the person's name"),
        ("2026-PatriciaLee!", "must not contain the person's name"),
        ("Password123", "is too common; choose one that is harder to guess"),
        ("1q2w3e4r5t", "is too common; choose one that is harder to guess"),
    ],
)
def test_the_policy_names_the_rule_that_failed(password: str, problem: str) -> None:
    found = password_problem(password, email="pat.lee@acme.test", full_name="Patricia  Lee")
    assert found == problem


@pytest.mark.parametrize(
    "password", ["Tangerine-Sky-42", "a" * 9 + "1", "A1" * 64, "pässwörter-2026", "correct horse 9"]
)
def test_the_policy_accepts_good_passwords(password: str) -> None:
    assert password_problem(password, email="pat.lee@acme.test", full_name="Patricia Lee") is None


@pytest.mark.parametrize(
    ("email", "full_name", "password", "problem"),
    [
        ("q@acme.test", "Patricia Lee", "Quiet-Morning-63", EMAIL_NAME_PROBLEM),
        ("q@acme.test", "Patricia Lee", "Oblique-Morning-63", EMAIL_NAME_PROBLEM),
        ("Q@acme.test", "Patricia Lee", "oblique-morning-63", EMAIL_NAME_PROBLEM),
        ("sk@acme.test", "Patricia Lee", "Tangerine-Sky-42", EMAIL_NAME_PROBLEM),
        ("SK@acme.test", "Patricia Lee", "tangerine-sky-42", EMAIL_NAME_PROBLEM),
        ("pat.lee@acme.test", "Q", "Quiet-Morning-63", PERSON_NAME_PROBLEM),
        ("pat.lee@acme.test", "q", "OBLIQUE-MORNING-63", PERSON_NAME_PROBLEM),
        ("pat.lee@acme.test", " Q ", "Oblique-Morning-63", PERSON_NAME_PROBLEM),
        ("pat.lee@acme.test", "Al", "Walnut-Grove-58", PERSON_NAME_PROBLEM),
        ("pat.lee@acme.test", "AL", "walnut-grove-58", PERSON_NAME_PROBLEM),
    ],
    ids=[
        "local-1-start", "local-1-inside", "local-1-case", "local-2", "local-2-case",
        "name-1-start", "name-1-case", "name-1-padded", "name-2", "name-2-case",
    ],
)
def test_the_policy_checks_one_and_two_character_names(
    email: str, full_name: str, password: str, problem: str
) -> None:
    """No minimum length: a one or two character email name or full name counts too."""
    assert password_problem(password, email=email, full_name=full_name) == problem


@pytest.mark.parametrize(
    ("email", "full_name"),
    [
        ("q@acme.test", "Patricia Lee"),
        ("zk@acme.test", "Patricia Lee"),
        ("pat.lee@acme.test", "Q"),
        ("pat.lee@acme.test", "Zk"),
    ],
    ids=["local-1", "local-2", "name-1", "name-2"],
)
def test_a_short_name_refuses_only_the_passwords_that_contain_it(
    email: str, full_name: str
) -> None:
    assert password_problem("Tangerine-Sky-42", email=email, full_name=full_name) is None


@pytest.mark.parametrize(
    ("email", "full_name"),
    [(None, None), ("", ""), ("@acme.test", "   "), ("  @acme.test", "\t")],
    ids=["unknown", "empty", "no-local-part", "blank"],
)
def test_a_missing_or_empty_name_refuses_nothing(email: str | None, full_name: str | None) -> None:
    """An empty string is "in" every password, so an empty name must never be compared."""
    assert password_problem("Tangerine-Sky-42", email=email, full_name=full_name) is None
    assert password_problem("Tangerine-Sky-42") is None


@pytest.mark.parametrize(
    ("password", "problem"),
    [
        ("my-PAT.LEE-2026", EMAIL_NAME_PROBLEM),
        ("my-pAt.LeE-2026", EMAIL_NAME_PROBLEM),
        ("2026 JÜRGEN GROSS!", PERSON_NAME_PROBLEM),
        ("2026-jÜrGeNgRoSs!", PERSON_NAME_PROBLEM),
        ("2026 jürgen groß!", PERSON_NAME_PROBLEM),
    ],
)
def test_the_name_rules_ignore_case(password: str, problem: str) -> None:
    """Case-insensitive for every letter: the capital of "ß" is "SS"."""
    found = password_problem(password, email="Pat.Lee@acme.test", full_name="Jürgen Groß")
    assert found == problem


def test_the_common_list_has_at_least_fifty_passwords_the_other_rules_would_accept() -> None:
    assert len(COMMON_PASSWORDS) >= 50
    for password in COMMON_PASSWORDS:
        assert password == password.lower()
        assert PASSWORD_MIN <= len(password) <= PASSWORD_MAX, password
        assert any(char.isalpha() for char in password), password
        assert any(char.isdigit() for char in password), password


@pytest.mark.parametrize(
    ("password", "message"),
    [
        ("Short-1", "must be at least 10 characters"),
        ("only-letters-here", "must contain at least one digit"),
        ("welcome12345", "is too common; choose one that is harder to guess"),
        ("zz-policy.check-99", "must not contain the email name (the part before the @)"),
        ("Policy Check 2026", "must not contain the person's name"),
    ],
)
def test_create_user_and_admin_reset_apply_the_policy(api, conn, password, message) -> None:
    new_user = {"email": "policy.check@acme.test", "full_name": "Policy Check",
                "password": password, "role": "viewer"}
    created = api.post("/auth/users", new_user)
    assert created.status == 400
    assert created.error["details"] == [{"field": "password", "message": message}]

    made = api.post("/auth/users", {**new_user, "password": GOOD_PASSWORD}).body
    reset = api.put(f"/auth/users/{made['id']}", {"password": password})
    assert reset.status == 400
    assert reset.error["details"] == [{"field": "password", "message": message}]


@pytest.mark.parametrize(
    ("email", "full_name", "password", "message"),
    [
        ("q@acme.test", "Short Local", "Quiet-Morning-63", EMAIL_NAME_PROBLEM),
        ("zk@acme.test", "Short Local", "Buzzkill-Ridge-63", EMAIL_NAME_PROBLEM),
        ("one.letter@acme.test", "Q", "Quiet-Morning-63", PERSON_NAME_PROBLEM),
        ("two.letters@acme.test", "Al", "Walnut-Grove-58", PERSON_NAME_PROBLEM),
    ],
    ids=["local-1", "local-2", "name-1", "name-2"],
)
def test_short_names_are_checked_in_create_reset_and_change(
    api, email: str, full_name: str, password: str, message: str
) -> None:
    new_user = {"email": email, "full_name": full_name, "password": password, "role": "viewer"}
    created = api.post("/auth/users", new_user)
    assert created.status == 400
    assert created.error["details"] == [{"field": "password", "message": message}]

    made = api.post("/auth/users", {**new_user, "password": GOOD_PASSWORD})
    assert made.status == 201
    reset = api.put(f"/auth/users/{made.body['id']}", {"password": password})
    assert reset.status == 400
    assert reset.error["details"] == [{"field": "password", "message": message}]

    token = _login(api, email, GOOD_PASSWORD).body["access_token"]
    refused = api.post(
        "/auth/change-password",
        {"current_password": GOOD_PASSWORD, "new_password": password}, token=token,
    )
    assert refused.status == 400
    assert refused.error["details"] == [{"field": "new_password", "message": message}]
    # a password without the short name is still accepted for the same account
    changed = api.post(
        "/auth/change-password",
        {"current_password": GOOD_PASSWORD, "new_password": ANOTHER_PASSWORD}, token=token,
    )
    assert changed.status == 200


def test_an_eight_character_password_is_no_longer_accepted(api) -> None:
    result = api.post("/auth/users", {"email": "eight@acme.test", "full_name": "Eight Chars",
                                      "password": "Abcdef12", "role": "viewer"})
    assert result.status == 400
    assert result.fields == {"password"}


# B5: temporary passwords


def test_an_admin_reset_marks_the_password_temporary(api, conn) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    assert api.get(f"/auth/users/{viewer_id}").body["must_change_password"] is False
    reset = api.put(f"/auth/users/{viewer_id}", {"password": GOOD_PASSWORD})
    assert reset.status == 200
    assert reset.body["must_change_password"] is True
    assert "password" not in {key for key in reset.body if key != "must_change_password"}

    login = _login(api, "viewer@acme.test", GOOD_PASSWORD)
    assert login.status == 200
    assert login.body["user"]["must_change_password"] is True
    refreshed = api.post("/auth/refresh", {"refresh_token": login.body["refresh_token"]}, role=None)
    assert refreshed.status == 403
    assert refreshed.error["code"] == "password_change_required"
    me = api.get("/auth/me", token=login.body["access_token"])
    assert me.status == 200
    assert me.body["must_change_password"] is True


def test_creating_a_user_does_not_mark_the_password_temporary(api) -> None:
    created = api.post("/auth/users", {"email": "fresh@acme.test", "full_name": "Fresh Start",
                                       "password": GOOD_PASSWORD, "role": "viewer"})
    assert created.body["must_change_password"] is False


def test_only_three_routes_answer_while_the_password_is_temporary(api, conn) -> None:
    import function

    conn.execute("UPDATE users SET must_change_password = true WHERE email = 'admin@acme.test'")
    blocked = 0
    for route in function.ROUTER.routes:
        if route.min_role is None or (route.method, route.template) in (
            ALLOWED_WHILE_PASSWORD_IS_TEMPORARY
        ):
            continue
        result = api.call(route.method, _concrete(route.template), body={})
        assert result.status == 403, f"{route.method} {route.template}"
        assert result.error["code"] == "password_change_required"
        blocked += 1
    assert blocked > 40
    assert api.get("/auth/me").status == 200
    # an unknown path is still a 404, and public routes still answer
    assert api.get("/nothing-here").status == 404
    assert api.get("/health", role=None).status == 200


def _temporary_session(api, conn) -> dict:
    """Sign the viewer in with a temporary password an admin has just set."""
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    assert api.put(f"/auth/users/{viewer_id}", {"password": GOOD_PASSWORD}).status == 200
    login = _login(api, "viewer@acme.test", GOOD_PASSWORD)
    assert login.status == 200
    assert login.body["user"]["must_change_password"] is True
    return login.body


def _refresh(api, session: dict):
    return api.post("/auth/refresh", {"refresh_token": session["refresh_token"]}, role=None)


def test_the_routes_allowed_with_a_temporary_password_are_exactly_these_three() -> None:
    assert auth.PASSWORD_CHANGE_ROUTES == ALLOWED_WHILE_PASSWORD_IS_TEMPORARY


def test_a_valid_refresh_token_cannot_bypass_a_temporary_password(api, conn) -> None:
    session = _temporary_session(api, conn)
    # nothing is wrong with the token itself: ours, unexpired, a refresh token, current version
    claims = _claims(session["refresh_token"])
    assert claims["typ"] == "refresh"
    assert claims["ver"] == _version(conn, "viewer@acme.test")
    for _ in range(2):
        refused = _refresh(api, session)
        assert refused.status == 403
        assert refused.error["code"] == "password_change_required"
        assert refused.error["message"] == (
            "Change your temporary password before doing anything else"
        )
        assert set(refused.body) == {"error"}
    # the refusal changes nothing: same version, flag still set, still held to the three routes
    assert _version(conn, "viewer@acme.test") == claims["ver"]
    blocked = api.get("/projects", token=session["access_token"])
    assert blocked.status == 403
    assert blocked.error["code"] == "password_change_required"
    me = api.get("/auth/me", token=session["access_token"])
    assert me.status == 200
    assert me.body["must_change_password"] is True


def test_refresh_is_refused_from_the_moment_the_flag_is_set(api, conn) -> None:
    """A session that began before the flag was set gets no new tokens either."""
    session = _session(api, "manager")
    assert _refresh(api, session).status == 200
    conn.execute("UPDATE users SET must_change_password = true WHERE email = 'manager@acme.test'")
    refused = _refresh(api, session)
    assert refused.status == 403
    assert refused.error["code"] == "password_change_required"


def test_a_bad_refresh_token_is_still_a_401_while_the_password_is_temporary(api, conn) -> None:
    session = _temporary_session(api, conn)
    conn.execute(
        "UPDATE users SET token_version = token_version + 1 WHERE email = 'viewer@acme.test'"
    )
    revoked = _refresh(api, session)
    assert revoked.status == 401
    assert revoked.error["code"] == "token_revoked"
    conn.execute("UPDATE users SET is_active = false WHERE email = 'viewer@acme.test'")
    inactive = _refresh(api, session)
    assert inactive.status == 401
    assert inactive.error["code"] == "invalid_token"
    wrong_type = api.post(
        "/auth/refresh", {"refresh_token": session["access_token"]}, role=None
    )
    assert wrong_type.status == 401


def test_refresh_works_again_once_the_password_is_changed(api, conn) -> None:
    temporary = _temporary_session(api, conn)
    assert _refresh(api, temporary).status == 403

    changed = api.post(
        "/auth/change-password",
        {"current_password": GOOD_PASSWORD, "new_password": ANOTHER_PASSWORD},
        token=temporary["access_token"],
    )
    assert changed.status == 200
    refreshed = _refresh(api, changed.body)
    assert refreshed.status == 200
    assert set(refreshed.body) == {
        "access_token", "refresh_token", "token_type", "expires_in", "user",
    }
    assert refreshed.body["user"]["email"] == "viewer@acme.test"
    assert refreshed.body["user"]["must_change_password"] is False
    assert api.get("/projects", token=refreshed.body["access_token"]).status == 200
    # refreshed tokens refresh in turn, and so does a new sign-in with the new password
    assert _refresh(api, refreshed.body).status == 200
    assert _refresh(api, _login(api, "viewer@acme.test", ANOTHER_PASSWORD).body).status == 200
    # the temporary session's refresh token was revoked by the change, not let through
    old = _refresh(api, temporary)
    assert old.status == 401
    assert old.error["code"] == "token_revoked"


def test_changing_the_password_lifts_the_block(api, conn) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    api.put(f"/auth/users/{viewer_id}", {"password": GOOD_PASSWORD})
    temporary = _login(api, "viewer@acme.test", GOOD_PASSWORD).body["access_token"]
    assert api.get("/projects", token=temporary).error["code"] == "password_change_required"

    changed = api.post(
        "/auth/change-password",
        {"current_password": GOOD_PASSWORD, "new_password": ANOTHER_PASSWORD}, token=temporary,
    )
    assert changed.status == 200
    assert changed.body["user"]["must_change_password"] is False
    assert api.get("/projects", token=changed.body["access_token"]).status == 200
    assert api.get(f"/auth/users/{viewer_id}").body["must_change_password"] is False


def test_a_user_with_a_temporary_password_can_still_sign_out(api, conn) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    api.put(f"/auth/users/{viewer_id}", {"password": GOOD_PASSWORD})
    session = _login(api, "viewer@acme.test", GOOD_PASSWORD).body
    assert api.post("/auth/logout", token=session["access_token"]).status == 204
    _assert_revoked(api, session)


# B6: login throttling


def _fail(api, email: str, times: int = 1) -> None:
    for _ in range(times):
        result = _login(api, email, "wrong-password-1")
        assert result.status == 401
        assert result.error["code"] == "invalid_credentials"


def _attempts(conn, email: str) -> int:
    return conn.execute(
        "SELECT count(*) AS n FROM login_attempts WHERE email = %s", (email,)
    ).fetchone()["n"]


def _age_attempts(conn, email: str, minutes: int) -> None:
    conn.execute(
        "UPDATE login_attempts SET attempted_at = attempted_at - make_interval(mins => %s) "
        "WHERE email = %s",
        (minutes, email),
    )


def test_the_failed_attempt_survives_the_401(api, conn) -> None:
    """The handler returns the 401 rather than raising it, so its insert is not rolled back."""
    _fail(api, "viewer@acme.test")
    assert _attempts(conn, "viewer@acme.test") == 1
    _fail(api, "viewer@acme.test")
    assert _attempts(conn, "viewer@acme.test") == 2


@pytest.mark.no_rollback
def test_failed_attempts_are_committed_and_visible_to_other_connections(database) -> None:
    import psycopg

    email = "committed-attempts@acme.test"
    body = {"email": email, "password": "wrong-password-1"}
    try:
        for _ in range(2):
            response = database.handler(make_event("POST", "/auth/login", body=body))
            assert response["statusCode"] == 401
        with psycopg.connect(host="localhost", port=5432, user="postgres", password=PG_PASSWORD,
                             dbname=TEST_DB, autocommit=True) as other:
            row = other.execute(
                "SELECT count(*) FROM login_attempts WHERE email = %s", (email,)
            ).fetchone()
        assert row[0] == 2
    finally:
        from acme.core import db

        db.get_connection(database.SETTINGS).execute(
            "DELETE FROM login_attempts WHERE email = %s", (email,)
        )


def test_the_sixth_attempt_is_throttled_even_with_the_right_password(api) -> None:
    _fail(api, "manager@acme.test", auth_domain.LOGIN_MAX_FAILURES)
    for password in ("wrong-password-1", SEED_PASSWORD):
        result = _login(api, "manager@acme.test", password)
        assert result.status == 429
        assert result.error["code"] == "too_many_attempts"
        assert result.error["message"] == "Too many attempts. Try again in 15 minutes."
        assert result.error["details"] == []
        assert 0 < int(result.headers["Retry-After"]) <= 15 * 60


def test_an_unknown_email_is_throttled_the_same_way(api) -> None:
    _fail(api, "nobody@acme.test", 5)
    result = _login(api, "nobody@acme.test", "wrong-password-1")
    assert result.status == 429
    assert "Retry-After" in result.headers


def test_throttling_is_per_email_and_ignores_case(api) -> None:
    _fail(api, "Viewer@ACME.test", 3)
    _fail(api, "viewer@acme.test", 2)
    assert _login(api, "VIEWER@acme.test").status == 429
    assert _login(api, "manager@acme.test").status == 200


def test_attempts_while_locked_do_not_extend_the_lock(api, conn) -> None:
    _fail(api, "viewer@acme.test", 5)
    for _ in range(3):
        assert _login(api, "viewer@acme.test", "wrong-password-1").status == 429
    assert _attempts(conn, "viewer@acme.test") == 5


def test_a_successful_login_clears_the_failures(api, conn) -> None:
    _fail(api, "viewer@acme.test", 4)
    assert _login(api, "viewer@acme.test").status == 200
    assert _attempts(conn, "viewer@acme.test") == 0
    _fail(api, "viewer@acme.test", 4)
    assert _login(api, "viewer@acme.test").status == 200


def test_the_lock_lifts_when_the_window_passes(api, conn) -> None:
    _fail(api, "viewer@acme.test", 5)
    _age_attempts(conn, "viewer@acme.test", 10)
    waiting = _login(api, "viewer@acme.test")
    assert waiting.status == 429
    assert 4 * 60 < int(waiting.headers["Retry-After"]) <= 5 * 60
    assert waiting.error["message"] == "Too many attempts. Try again in 5 minutes."

    _age_attempts(conn, "viewer@acme.test", 4)
    almost = _login(api, "viewer@acme.test")
    assert almost.status == 429
    assert almost.error["message"] == "Too many attempts. Try again in 1 minute."

    _age_attempts(conn, "viewer@acme.test", 2)
    assert _login(api, "viewer@acme.test").status == 200


def test_only_failures_inside_the_window_count(api, conn) -> None:
    _fail(api, "viewer@acme.test", 4)
    _age_attempts(conn, "viewer@acme.test", 16)
    _fail(api, "viewer@acme.test", 4)
    assert _login(api, "viewer@acme.test").status == 200


def test_attempts_older_than_a_day_are_deleted_on_the_next_write(api, conn) -> None:
    _fail(api, "old-attempts@acme.test", 2)
    conn.execute(
        "UPDATE login_attempts SET attempted_at = attempted_at - interval '25 hours' "
        "WHERE email = 'old-attempts@acme.test'"
    )
    _fail(api, "someone-else@acme.test")
    assert _attempts(conn, "old-attempts@acme.test") == 0
    assert _attempts(conn, "someone-else@acme.test") == 1


def test_a_malformed_login_is_not_counted(api, conn) -> None:
    for _ in range(6):
        assert api.post("/auth/login", {"email": "viewer@acme.test"}, role=None).status == 400
    assert _attempts(conn, "viewer@acme.test") == 0
    assert _login(api, "viewer@acme.test").status == 200


def test_an_inactive_account_counts_as_a_failure(api, conn) -> None:
    conn.execute("UPDATE users SET is_active = false WHERE email = 'viewer@acme.test'")
    for _ in range(5):
        result = _login(api, "viewer@acme.test")
        assert result.status == 401
        assert result.error["code"] == "account_inactive"
    assert _login(api, "viewer@acme.test").status == 429


def test_an_admin_can_unlock_an_account(api, conn) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    listed = {user["email"]: user for user in api.get("/auth/users").body["items"]}
    assert listed["viewer@acme.test"]["is_locked"] is False
    _fail(api, "viewer@acme.test", 5)
    assert _login(api, "viewer@acme.test").status == 429
    listed = {user["email"]: user for user in api.get("/auth/users").body["items"]}
    assert listed["viewer@acme.test"]["is_locked"] is True
    assert listed["manager@acme.test"]["is_locked"] is False
    assert api.get(f"/auth/users/{viewer_id}").body["is_locked"] is True

    result = api.delete(f"/auth/users/{viewer_id}/lockout")
    assert result.status == 204
    assert _attempts(conn, "viewer@acme.test") == 0
    assert api.get(f"/auth/users/{viewer_id}").body["is_locked"] is False
    assert _login(api, "viewer@acme.test").status == 200


@pytest.mark.parametrize("role", ["viewer", "contributor", "manager"])
def test_only_admins_unlock_accounts(api, conn, role: str) -> None:
    viewer_id = id_of(conn, "users", "email", "viewer@acme.test")
    assert api.delete(f"/auth/users/{viewer_id}/lockout", role=role).status == 403
    assert api.delete(f"/auth/users/{viewer_id}/lockout", role=None).status == 401


def test_unlocking_an_unknown_user_is_404(api) -> None:
    assert api.delete("/auth/users/999999/lockout").status == 404


def test_extra_response_headers_reach_the_function_url_response() -> None:
    from acme.core.http import Response, to_lambda

    encoded = to_lambda(Response(429, {"error": {}}, {"Retry-After": "30"}))
    assert encoded["headers"]["Retry-After"] == "30"
    assert encoded["headers"]["Content-Type"] == "application/json"
    assert to_lambda(Response(204, None, {"X-Extra": "1"}))["headers"]["X-Extra"] == "1"


# Guards behind the rules above


@pytest.mark.parametrize(
    "claims", [{"role": "superuser"}, {"sub": "seven"}, {"sub": "-1"}], ids=["role", "sub", "minus"]
)
def test_a_signed_token_with_an_unknown_role_or_subject_is_refused(
    api, conn, database, claims: dict
) -> None:
    admin_id = id_of(conn, "users", "email", "admin@acme.test")
    now = datetime.now(timezone.utc)
    forged = {"sub": str(admin_id), "role": "admin", "typ": "access", "ver": 0, "iat": now,
              "exp": now + timedelta(minutes=5), **claims}
    token = jwt.encode(forged, database.SETTINGS.jwt_secret, algorithm="HS256")
    result = api.get("/auth/me", token=token)
    assert result.status == 401
    assert result.error["code"] == "invalid_token"
