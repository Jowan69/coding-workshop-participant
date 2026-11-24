"""Resources: CRUD, today's allocation, validation, filters, search and roles."""

from __future__ import annotations

import pytest

from conftest import id_of

PERSON = {"full_name": "Ivy Novak", "email": "Ivy.Novak@ACME.test", "job_title": "Data Engineer",
          "department": "Engineering"}


def test_list_includes_todays_allocation(api) -> None:
    result = api.get("/resources", role="viewer")
    assert result.status == 200
    assert result.body["total"] == 8
    today = {r["email"]: r["allocation_today_pct"] for r in result.body["items"]}
    assert today["aisha.khan@acme.test"] == 120
    assert today["farid.haddad@acme.test"] == 120
    assert today["ben.carter@acme.test"] == 90
    assert today["grace.liu@acme.test"] == 40
    assert today["emma.wilson@acme.test"] == 0


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ({"department": "Engineering"}, 4),
        ({"is_active": "true"}, 8),
        ({"is_active": "false"}, 0),
        ({"q": "engineer"}, 4),
        ({"q": "HADDAD"}, 1),
        ({"q": "emma.wilson@"}, 1),
    ],
)
def test_filters_and_search(api, query: dict, expected: int) -> None:
    assert api.get("/resources", query=query).body["total"] == expected


def test_sort_and_paginate(api) -> None:
    by_capacity = api.get("/resources", query={"sort": "capacity_pct", "limit": 1}).body
    assert by_capacity["items"][0]["email"] == "grace.liu@acme.test"
    assert by_capacity["total"] == 8
    assert api.get("/resources", query={"is_active": "yes"}).status == 400


def test_create_with_defaults(api) -> None:
    result = api.post("/resources", PERSON, role="contributor")
    assert result.status == 201
    assert result.body["email"] == "ivy.novak@acme.test"
    assert result.body["capacity_pct"] == 100
    assert result.body["is_active"] is True
    assert result.body["allocation_today_pct"] == 0


def test_duplicate_email_is_a_conflict(api) -> None:
    result = api.post("/resources", {**PERSON, "email": "AISHA.KHAN@acme.test"})
    assert result.status == 409
    assert result.fields == {"email"}


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"email": "not-an-email"}, "email"),
        ({"capacity_pct": 0}, "capacity_pct"),
        ({"capacity_pct": 101}, "capacity_pct"),
        ({"capacity_pct": None}, "capacity_pct"),
        ({"is_active": "yes"}, "is_active"),
        ({"full_name": ""}, "full_name"),
    ],
)
def test_validation(api, change: dict, field: str) -> None:
    result = api.post("/resources", {**PERSON, **change})
    assert result.status == 400
    assert result.fields == {field}


def test_update_and_get(api, conn) -> None:
    grace = id_of(conn, "resources", "email", "grace.liu@acme.test")
    result = api.put(f"/resources/{grace}", {"capacity_pct": 80, "is_active": False})
    assert result.status == 200
    assert (result.body["capacity_pct"], result.body["is_active"]) == (80, False)
    assert api.get(f"/resources/{grace}", role="viewer").body["capacity_pct"] == 80
    assert api.get("/resources/999999").status == 404


def test_delete_unassigns_deliverables_and_drops_allocations(api, conn) -> None:
    ben = id_of(conn, "resources", "email", "ben.carter@acme.test")
    assert api.delete(f"/resources/{ben}", role="contributor").status == 403
    assert api.delete(f"/resources/{ben}", role="manager").status == 204
    counts = conn.execute(
        "SELECT (SELECT count(*) FROM allocations WHERE resource_id = %s) AS allocations, "
        "(SELECT count(*) FROM deliverables WHERE assignee_id = %s) AS assigned",
        (ben, ben),
    ).fetchone()
    assert counts == {"allocations": 0, "assigned": 0}


def test_viewer_is_read_only(api, conn) -> None:
    grace = id_of(conn, "resources", "email", "grace.liu@acme.test")
    assert api.post("/resources", PERSON, role="viewer").status == 403
    assert api.put(f"/resources/{grace}", {"capacity_pct": 60}, role="viewer").status == 403
    assert api.get("/resources", role=None).status == 401
