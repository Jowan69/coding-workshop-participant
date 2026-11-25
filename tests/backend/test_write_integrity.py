"""Phase 6, part D: idempotency keys, lost-update protection and project ownership."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from acme.core import db
from conftest import (
    CLOUD_PREFIX,
    PG_PASSWORD,
    ROLE_EMAILS,
    SEED_PASSWORD,
    TEST_DB,
    id_of,
    make_event,
)

KEY = "order-7f3a9c2e-0001"
OTHER_KEY = "order-7f3a9c2e-0002"


def _connect() -> psycopg.Connection:
    return psycopg.connect(
        host="localhost", port=5432, user="postgres", password=PG_PASSWORD, dbname=TEST_DB,
        autocommit=True, row_factory=dict_row,
    )


def _keyed(key: str) -> dict[str, str]:
    return {"Idempotency-Key": key}


@pytest.fixture
def portal(conn) -> int:
    return id_of(conn, "projects", "name", "Customer Portal Revamp")


def _entry(project_id: int, **change: Any) -> dict[str, Any]:
    return {"project_id": project_id, "category": "software", "amount": 1999.99,
            "spent_on": "2026-03-01", "description": "Idempotency check", **change}


def _entries(conn, description: str = "Idempotency check") -> int:
    return conn.execute(
        "SELECT count(*) AS n FROM budget_entries WHERE description = %s", (description,)
    ).fetchone()["n"]


def _post_entry(api, project_id: int, key: str, role: str = "contributor", **change: Any):
    return api.post("/budgets", _entry(project_id, **change), headers=_keyed(key), role=role)


def _stored(conn, key: str) -> dict | None:
    return conn.execute("SELECT * FROM idempotency_keys WHERE key = %s", (key,)).fetchone()


# D2: idempotency keys


def test_a_repeated_post_with_the_same_key_runs_once(api, conn, portal) -> None:
    first = _post_entry(api, portal, KEY)
    second = _post_entry(api, portal, KEY)
    third = _post_entry(api, portal, KEY)
    assert (first.status, second.status, third.status) == (201, 201, 201)
    assert first.body == second.body == third.body
    assert first.body["amount"] == 1999.99 and first.body["spent_on"] == "2026-03-01"
    assert _entries(conn) == 1
    assert "Idempotent-Replayed" not in first.headers
    assert second.headers["Idempotent-Replayed"] == "true"
    stored = _stored(conn, KEY)
    assert (stored["method"], stored["path"], stored["status"]) == ("POST", "/budgets", 201)
    assert stored["user_id"] == id_of(conn, "users", "email", ROLE_EMAILS["contributor"])
    assert stored["response"]["id"] == first.body["id"]


def test_without_a_key_every_post_runs(api, conn, portal) -> None:
    for _ in range(2):
        assert api.post("/budgets", _entry(portal), role="contributor").status == 201
    assert _entries(conn) == 2
    assert conn.execute("SELECT count(*) AS n FROM idempotency_keys").fetchone()["n"] == 0


def test_a_different_key_is_a_different_request(api, conn, portal) -> None:
    first = _post_entry(api, portal, KEY)
    second = _post_entry(api, portal, OTHER_KEY)
    assert first.body["id"] != second.body["id"]
    assert _entries(conn) == 2


def test_the_header_name_is_case_insensitive_and_both_path_styles_share_a_key(
    conn, portal, tokens, database
) -> None:
    def post(prefix: str, header: str) -> dict:
        event = make_event(
            "POST", prefix + "/budgets", body=_entry(portal),
            headers={header: KEY, "authorization": f"Bearer {tokens['contributor']}"},
        )
        return database.handler(event)

    local = post("", "idempotency-key")
    cloud = post(CLOUD_PREFIX, "IDEMPOTENCY-KEY")
    assert local["statusCode"] == cloud["statusCode"] == 201
    assert json.loads(local["body"]) == json.loads(cloud["body"])
    assert _entries(conn) == 1


def test_the_same_key_on_another_path_is_refused(api, conn, portal) -> None:
    assert _post_entry(api, portal, KEY).status == 201
    deliverable = {"project_id": portal, "title": "Reused key", "due_date": "2026-05-01"}
    reused = api.post("/deliverables", deliverable, headers=_keyed(KEY), role="contributor")
    assert reused.status == 409
    assert reused.error["code"] == "idempotency_key_reused"
    assert conn.execute(
        "SELECT count(*) AS n FROM deliverables WHERE title = 'Reused key'"
    ).fetchone()["n"] == 0


def test_the_same_key_from_another_user_is_refused(api, conn, portal) -> None:
    assert _post_entry(api, portal, KEY).status == 201
    reused = _post_entry(api, portal, KEY, role="manager")
    assert reused.status == 409
    assert reused.error["code"] == "idempotency_key_reused"
    assert _entries(conn) == 1


def test_a_replay_returns_the_stored_response_even_if_the_body_differs(api, conn, portal) -> None:
    first = _post_entry(api, portal, KEY)
    replay = api.post(
        "/budgets", _entry(portal, amount=5, description="Another entry"), headers=_keyed(KEY),
        role="contributor",
    )
    assert replay.status == 201
    assert replay.body == first.body
    assert _entries(conn, "Another entry") == 0


@pytest.mark.parametrize(
    "bad",
    [{"amount": -1}, {"project_id": 999999}, {"category": "bribes"}],
    ids=["validation", "missing-reference", "bad-enum"],
)
def test_a_failed_request_stores_nothing_and_the_key_can_be_retried(
    api, conn, portal, bad: dict
) -> None:
    failed = api.post(
        "/budgets", {**_entry(portal), **bad}, headers=_keyed(KEY), role="contributor"
    )
    assert failed.status == 400
    assert _stored(conn, KEY) is None
    retried = _post_entry(api, portal, KEY)
    assert retried.status == 201
    assert "Idempotent-Replayed" not in retried.headers
    assert _entries(conn) == 1


def test_a_conflict_stores_nothing(api, conn) -> None:
    project = {"name": "Customer Portal Revamp", "department": "IT",
               "start_date": "2026-01-01", "end_date": "2026-02-01"}
    assert api.post("/projects", project, headers=_keyed(KEY)).status == 409
    assert _stored(conn, KEY) is None


@pytest.mark.parametrize(
    "key", ["short", "has space 123", "semi;colon-123", "a" * 129, "", "ünïcödé-key-1"]
)
def test_a_malformed_key_is_a_400(api, conn, portal, key: str) -> None:
    result = _post_entry(api, portal, key)
    assert result.status == 400
    assert result.error["code"] == "validation_error"
    assert result.fields == {"Idempotency-Key"}
    assert _entries(conn) == 0


@pytest.mark.parametrize(
    "key", ["a" * 8, "A" * 128, "Abc_123-xyz", "550e8400-e29b-41d4-a716-446655440000"]
)
def test_well_formed_keys_are_accepted(api, portal, key: str) -> None:
    assert _post_entry(api, portal, key).status == 201


def test_keys_older_than_a_day_are_deleted_on_the_next_keyed_write(api, conn, portal) -> None:
    lead = id_of(conn, "users", "email", ROLE_EMAILS["contributor"])
    for key, age in (("old-key-000001", "25 hours"), ("recent-key-0001", "23 hours")):
        conn.execute(
            "INSERT INTO idempotency_keys (key, user_id, method, path, status, created_at) "
            "VALUES (%s, %s, 'POST', '/budgets', 201, now() - %s::interval)",
            (key, lead, age),
        )
    assert _post_entry(api, portal, KEY).status == 201
    assert _stored(conn, "old-key-000001") is None
    assert _stored(conn, "recent-key-0001") is not None
    assert _stored(conn, KEY) is not None


def test_an_expired_key_can_be_used_again(api, conn, portal) -> None:
    first = _post_entry(api, portal, KEY)
    conn.execute("UPDATE idempotency_keys SET created_at = now() - interval '25 hours'")
    again = _post_entry(api, portal, KEY)
    assert again.status == 201
    assert again.body["id"] != first.body["id"]


def test_the_key_is_ignored_on_other_methods(api, conn, portal) -> None:
    created = api.post("/budgets", _entry(portal), role="contributor").body
    assert api.get("/budgets", headers=_keyed(KEY), role="viewer").status == 200
    updated = api.put(
        f"/budgets/{created['id']}", {"amount": 10}, headers=_keyed(KEY), role="contributor"
    )
    assert updated.status == 200
    deleted = api.delete(f"/budgets/{created['id']}", headers=_keyed(KEY), role="manager")
    assert deleted.status == 204
    assert _stored(conn, KEY) is None


def test_session_routes_never_store_a_response(api, conn) -> None:
    credentials = {"email": "viewer@acme.test", "password": SEED_PASSWORD}
    login = api.post("/auth/login", credentials, headers=_keyed(KEY), role=None)
    assert login.status == 200
    again = api.post("/auth/login", credentials, headers=_keyed(KEY), role=None)
    assert again.body["access_token"] and "Idempotent-Replayed" not in again.headers
    refresh = api.post(
        "/auth/refresh", {"refresh_token": login.body["refresh_token"]}, headers=_keyed(KEY),
        role=None,
    )
    assert refresh.status == 200
    change = {"current_password": SEED_PASSWORD, "new_password": "Tangerine-Sky-42"}
    changed = api.post(
        "/auth/change-password", change, headers=_keyed(KEY), token=login.body["access_token"]
    )
    assert changed.status == 200
    # not replayed: the second call runs, and the current password is no longer the old one
    repeated = api.post(
        "/auth/change-password", change, headers=_keyed(KEY), token=changed.body["access_token"]
    )
    assert repeated.status == 400
    assert api.post(
        "/auth/logout", headers=_keyed(KEY), token=changed.body["access_token"]
    ).status == 204
    assert _stored(conn, KEY) is None
    stored = conn.execute("SELECT response::text AS body FROM idempotency_keys").fetchall()
    assert not any("token" in row["body"] for row in stored)


def test_deleting_a_user_removes_their_keys(api, conn) -> None:
    created = api.post("/auth/users", {"email": "short.stay@acme.test", "full_name": "Short Stay",
                                       "password": "Tangerine-Sky-42", "role": "contributor"}).body
    token = api.post(
        "/auth/login", {"email": "short.stay@acme.test", "password": "Tangerine-Sky-42"}, role=None
    ).body["access_token"]
    person = {"full_name": "Keyed Person", "email": "keyed.person@acme.test"}
    assert api.post("/resources", person, headers=_keyed(KEY), token=token).status == 201
    assert _stored(conn, KEY) is not None
    assert api.delete(f"/auth/users/{created['id']}").status == 204
    assert _stored(conn, KEY) is None


class _PerThreadConnections:
    """Give every thread that calls the handler its own database connection.

    A Lambda container keeps one connection, so concurrent requests are separate
    connections. In one test process the same is achieved by handing each thread its own.
    """

    def __init__(self, monkeypatch) -> None:
        self._local = threading.local()
        self._all: list[psycopg.Connection] = []
        self._lock = threading.Lock()
        monkeypatch.setattr(db, "get_connection", self._get)

    def _get(self, settings) -> psycopg.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None or conn.closed:
            conn = self._local.conn = _connect()
            with self._lock:
                self._all.append(conn)
        return conn

    def close(self) -> None:
        for conn in self._all:
            conn.close()


@pytest.mark.no_rollback
def test_six_concurrent_identical_posts_with_one_key_create_one_row(
    database, tokens, monkeypatch
) -> None:
    marker = "Concurrent idempotency check"
    key = "concurrent-key-0001"
    connections = _PerThreadConnections(monkeypatch)
    admin = _connect()
    try:
        project_id = admin.execute(
            "SELECT id FROM projects WHERE name = 'Customer Portal Revamp'"
        ).fetchone()["id"]
        event = make_event(
            "POST", "/budgets", body=_entry(project_id, description=marker),
            headers={"idempotency-key": key, "authorization": f"Bearer {tokens['contributor']}"},
        )
        barrier = threading.Barrier(6)
        responses: list[dict] = []

        def post() -> None:
            barrier.wait(timeout=10)
            responses.append(database.handler(dict(event)))

        threads = [threading.Thread(target=post) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert len(responses) == 6
        assert [response["statusCode"] for response in responses] == [201] * 6
        bodies = [json.loads(response["body"]) for response in responses]
        assert len({body["id"] for body in bodies}) == 1
        assert all(body == bodies[0] for body in bodies)
        replayed = [r for r in responses if r["headers"].get("Idempotent-Replayed") == "true"]
        assert len(replayed) == 5
        rows = admin.execute(
            "SELECT count(*) AS n FROM budget_entries WHERE description = %s", (marker,)
        ).fetchone()["n"]
        assert rows == 1
    finally:
        admin.execute("DELETE FROM budget_entries WHERE description = %s", (marker,))
        admin.execute("DELETE FROM idempotency_keys WHERE key = %s", (key,))
        admin.close()
        connections.close()


@pytest.mark.no_rollback
def test_without_a_key_six_concurrent_posts_create_six_rows(database, tokens, monkeypatch) -> None:
    """The control for the test above: the key, not luck, is what collapses the requests."""
    marker = "Concurrent control check"
    connections = _PerThreadConnections(monkeypatch)
    admin = _connect()
    try:
        project_id = admin.execute(
            "SELECT id FROM projects WHERE name = 'Customer Portal Revamp'"
        ).fetchone()["id"]
        event = make_event(
            "POST", "/budgets", body=_entry(project_id, description=marker),
            headers={"authorization": f"Bearer {tokens['contributor']}"},
        )
        statuses: list[int] = []

        def post() -> None:
            statuses.append(database.handler(dict(event))["statusCode"])

        threads = [threading.Thread(target=post) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        assert statuses == [201] * 6
        rows = admin.execute(
            "SELECT count(*) AS n FROM budget_entries WHERE description = %s", (marker,)
        ).fetchone()["n"]
        assert rows == 6
    finally:
        admin.execute("DELETE FROM budget_entries WHERE description = %s", (marker,))
        admin.close()
        connections.close()


# D3: lost updates


PROJECT = {"name": "Stale check", "department": "IT", "start_date": "2026-01-01",
           "end_date": "2026-06-30"}


def test_an_update_from_the_latest_copy_succeeds_and_a_stale_one_is_refused(api) -> None:
    created = api.post("/projects", PROJECT).body
    first = api.put(
        f"/projects/{created['id']}",
        {"description": "First editor", "expected_updated_at": created["updated_at"]},
    )
    assert first.status == 200
    assert first.body["updated_at"] != created["updated_at"]

    stale = api.put(
        f"/projects/{created['id']}",
        {"description": "Second editor", "expected_updated_at": created["updated_at"]},
    )
    assert stale.status == 409
    assert stale.error["code"] == "stale_record"
    assert "changed by someone else" in stale.error["message"]
    assert stale.error["details"] == []
    assert api.get(f"/projects/{created['id']}").body["description"] == "First editor"

    retried = api.put(
        f"/projects/{created['id']}",
        {"description": "Second editor", "expected_updated_at": first.body["updated_at"]},
    )
    assert retried.status == 200


def test_updates_without_expected_updated_at_are_not_checked(api) -> None:
    created = api.post("/projects", PROJECT).body
    assert api.put(f"/projects/{created['id']}", {"description": "one"}).status == 200
    assert api.put(f"/projects/{created['id']}", {"description": "two"}).status == 200
    for blank in (None, ""):
        body = {"description": "three", "expected_updated_at": blank}
        assert api.put(f"/projects/{created['id']}", body).status == 200


def test_timestamps_are_compared_as_instants_not_as_text(api) -> None:
    created = api.post("/projects", PROJECT).body
    url = f"/projects/{created['id']}"
    india = timezone(timedelta(hours=5, minutes=30))
    newfoundland = timezone(-timedelta(hours=3, minutes=30))

    instant = datetime.fromisoformat(created["updated_at"])
    assert instant.tzinfo is not None
    as_zulu = instant.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    updated = api.put(url, {"description": "zulu", "expected_updated_at": as_zulu})
    assert updated.status == 200, as_zulu

    for zone in (india, newfoundland, timezone.utc):
        instant = datetime.fromisoformat(updated.body["updated_at"])
        text = instant.astimezone(zone).isoformat()
        updated = api.put(url, {"description": text, "expected_updated_at": text})
        assert updated.status == 200, text

    instant = datetime.fromisoformat(updated.body["updated_at"])
    a_microsecond_off = (instant + timedelta(microseconds=1)).isoformat()
    off = api.put(
        f"/projects/{created['id']}",
        {"description": "off", "expected_updated_at": a_microsecond_off},
    )
    assert off.status == 409


@pytest.mark.parametrize("bad", ["yesterday", "2026-01-01T10:00:00", 1767261600, True, ["x"]])
def test_a_malformed_expected_updated_at_is_a_field_error(api, bad) -> None:
    created = api.post("/projects", PROJECT).body
    result = api.put(
        f"/projects/{created['id']}", {"description": "x", "expected_updated_at": bad}
    )
    assert result.status == 400
    assert result.fields == {"expected_updated_at"}


def test_staleness_is_judged_before_the_body_is_validated(api) -> None:
    created = api.post("/projects", PROJECT).body
    api.put(f"/projects/{created['id']}", {"description": "moved on"})
    result = api.put(
        f"/projects/{created['id']}",
        {"end_date": "not a date", "expected_updated_at": created["updated_at"]},
    )
    assert result.status == 409


def _existing_rows(api, conn) -> dict[str, tuple[dict, dict]]:
    """One row per resource, with a harmless change to apply to it."""
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    paths = {
        "/projects": ({}, {"description": "changed"}),
        "/deliverables": ({"project_id": portal}, {"description": "changed"}),
        "/resources": ({}, {"job_title": "changed"}),
        "/allocations": ({"project_id": portal}, {"role_on_project": "changed"}),
        "/budgets": ({"project_id": portal}, {"description": "changed"}),
        "/auth/users": ({"role": "viewer"}, {"full_name": "Changed Name"}),
    }
    return {
        path: (api.get(path, query={**query, "limit": 1}).body["items"][0], change)
        for path, (query, change) in paths.items()
    }


def test_every_resource_refuses_a_stale_update(api, conn) -> None:
    for path, (row, change) in _existing_rows(api, conn).items():
        url = f"{path}/{row['id']}"
        fresh = api.put(url, {**change, "expected_updated_at": row["updated_at"]})
        assert fresh.status == 200, path
        stale = api.put(url, {**change, "expected_updated_at": row["updated_at"]})
        assert stale.status == 409, path
        assert stale.error["code"] == "stale_record", path


@pytest.mark.no_rollback
def test_the_stale_check_waits_for_a_writer_holding_the_row(database, tokens, monkeypatch) -> None:
    """The comparison runs under the row lock, so it cannot slip between another write."""
    connections = _PerThreadConnections(monkeypatch)
    admin = _connect()
    writer = _connect()
    name = "Row lock stale check"
    try:
        admin.execute("DELETE FROM projects WHERE name = %s", (name,))
        row = admin.execute(
            "INSERT INTO projects (name, department, start_date, end_date) "
            "VALUES (%s, 'IT', '2026-01-01', '2026-02-01') RETURNING id, updated_at",
            (name,),
        ).fetchone()
        event = make_event(
            "PUT", f"/projects/{row['id']}",
            body={"description": "from the stale copy",
                  "expected_updated_at": row["updated_at"].isoformat()},
            headers={"authorization": f"Bearer {tokens['manager']}"},
        )
        result: list[dict] = []
        with writer.transaction():
            writer.execute(
                "UPDATE projects SET description = 'from the first writer', "
                "updated_at = clock_timestamp() WHERE id = %s",
                (row["id"],),
            )
            thread = threading.Thread(target=lambda: result.append(database.handler(event)))
            thread.start()
            time.sleep(0.5)
            assert thread.is_alive(), "the update should wait for the row lock"
            assert result == []
        thread.join(timeout=30)
        assert result[0]["statusCode"] == 409
        assert json.loads(result[0]["body"])["error"]["code"] == "stale_record"
        kept = admin.execute(
            "SELECT description FROM projects WHERE id = %s", (row["id"],)
        ).fetchone()["description"]
        assert kept == "from the first writer"
    finally:
        admin.execute("DELETE FROM projects WHERE name = %s", (name,))
        admin.close()
        writer.close()
        connections.close()


# D4: ownership


@pytest.mark.parametrize("role", ["contributor", "manager", "admin"])
def test_a_project_without_an_owner_belongs_to_its_creator(api, conn, role: str) -> None:
    created = api.post("/projects", PROJECT, role=role)
    assert created.status == 201
    assert created.body["owner_id"] == id_of(conn, "users", "email", ROLE_EMAILS[role])
    assert created.body["owner_name"]


def test_an_explicit_owner_or_no_owner_is_respected(api, conn) -> None:
    viewer = id_of(conn, "users", "email", ROLE_EMAILS["viewer"])
    named = api.post("/projects", {**PROJECT, "owner_id": viewer}, role="contributor")
    assert named.body["owner_id"] == viewer
    assert named.body["owner_name"] == "Tom Becker"
    nobody = api.post(
        "/projects", {**PROJECT, "name": "Nobody's project", "owner_id": None}, role="contributor"
    )
    assert nobody.status == 201
    assert nobody.body["owner_id"] is None and nobody.body["owner_name"] is None


def test_an_update_never_reassigns_the_owner_by_itself(api, conn) -> None:
    created = api.post("/projects", PROJECT, role="contributor").body
    updated = api.put(f"/projects/{created['id']}", {"description": "edited"}, role="manager")
    assert updated.body["owner_id"] == created["owner_id"]
    cleared = api.put(f"/projects/{created['id']}", {"owner_id": None}, role="manager")
    assert cleared.body["owner_id"] is None


@pytest.mark.parametrize("role", ["contributor", "manager", "admin"])
def test_owner_options_list_active_users_by_name(api, conn, role: str) -> None:
    conn.execute("UPDATE users SET is_active = false WHERE email = 'viewer@acme.test'")
    result = api.get("/auth/users/options", role=role)
    assert result.status == 200
    assert [item["full_name"] for item in result.body["items"]] == [
        "Daniel Okafor", "Maria Gonzalez", "Priya Shah",
    ]
    assert all(set(item) == {"id", "full_name"} for item in result.body["items"])
    assert result.body["total"] == 3


def test_owner_options_need_contributor(api) -> None:
    assert api.get("/auth/users/options", role="viewer").status == 403
    assert api.get("/auth/users/options", role=None).status == 401


# Guards behind the rules above


def test_an_error_a_handler_returns_instead_of_raising_releases_the_key(
    api, conn, portal, monkeypatch
) -> None:
    import dataclasses

    import function
    from acme.core.http import Response, error_body

    def refuse(request):
        return Response(409, error_body("conflict", "returned, not raised"))

    patched = [
        dataclasses.replace(route, handler=refuse)
        if (route.method, route.template) == ("POST", "/budgets") else route
        for route in function.ROUTER.routes
    ]
    monkeypatch.setattr(function.ROUTER, "routes", patched)
    assert _post_entry(api, portal, KEY).status == 409
    assert _stored(conn, KEY) is None


@pytest.mark.parametrize("body", [[], ["expected_updated_at"], "text", 7])
def test_an_update_whose_body_is_not_an_object_is_a_400(api, body) -> None:
    created = api.post("/projects", PROJECT).body
    result = api.put(f"/projects/{created['id']}", body)
    assert result.status == 400
    assert result.error["message"] == "Request body must be a JSON object"
