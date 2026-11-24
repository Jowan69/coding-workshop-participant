"""Allocations: CRUD, validation, filters and the over-allocation warning."""

from __future__ import annotations

from datetime import timedelta

import pytest

from conftest import id_of

TODAY = {}


def _day(offset: int) -> str:
    """A date relative to the database's CURRENT_DATE (the seed's reference day)."""
    return (TODAY["value"] + timedelta(days=offset)).isoformat()


@pytest.fixture
def ids(conn):
    TODAY["value"] = conn.execute("SELECT CURRENT_DATE AS today").fetchone()["today"]
    return {
        "ben": id_of(conn, "resources", "email", "ben.carter@acme.test"),
        "grace": id_of(conn, "resources", "email", "grace.liu@acme.test"),
        "aisha": id_of(conn, "resources", "email", "aisha.khan@acme.test"),
        "portal": id_of(conn, "projects", "name", "Customer Portal Revamp"),
        "study": id_of(conn, "projects", "name", "Market Expansion Study"),
    }


def _allocation(ids, person: str, pct: int, start: int, end: int, project: str = "study"):
    return {"resource_id": ids[person], "project_id": ids[project], "allocation_pct": pct,
            "start_date": _day(start), "end_date": _day(end), "role_on_project": "Analyst"}


def test_list_and_filters(api, ids) -> None:
    assert api.get("/allocations", role="viewer").body["total"] == 15
    assert api.get("/allocations", query={"resource_id": ids["aisha"]}).body["total"] == 2
    assert api.get("/allocations", query={"project_id": ids["portal"]}).body["total"] == 3
    active = api.get("/allocations", query={"active_on": _day(0), "resource_id": ids["aisha"]})
    assert active.body["total"] == 2
    assert api.get("/allocations", query={"active_on": _day(200)}).body["total"] == 0
    assert api.get("/allocations", query={"active_on": "tomorrow"}).status == 400
    by_pct = api.get("/allocations", query={"sort": "-allocation_pct", "limit": 1}).body
    assert by_pct["items"][0]["allocation_pct"] == 80


def test_within_capacity_has_no_warning(api, ids) -> None:
    result = api.post("/allocations", _allocation(ids, "ben", 10, 0, 10), role="contributor")
    assert result.status == 201
    assert "warning" not in result.body
    assert result.body["allocation_pct"] == 10


def test_over_capacity_is_allowed_with_a_warning(api, ids) -> None:
    result = api.post("/allocations", _allocation(ids, "ben", 20, 0, 10))
    assert result.status == 201
    assert result.body["warning"] == "over_allocated"
    assert result.body["total_allocation_pct"] == 110
    assert result.body["capacity_pct"] == 100


def test_part_time_capacity_counts(api, ids) -> None:
    result = api.post("/allocations", _allocation(ids, "grace", 20, 0, 5))
    assert result.body["warning"] == "over_allocated"
    assert (result.body["total_allocation_pct"], result.body["capacity_pct"]) == (60, 50)


def test_peak_is_not_a_naive_sum(api, conn, ids) -> None:
    person = api.post("/resources", {"full_name": "Jo Park", "email": "jo.park@acme.test"}).body
    ids["jo"] = person["id"]
    api.post("/allocations", _allocation(ids, "jo", 50, 0, 10))
    api.post("/allocations", _allocation(ids, "jo", 50, 20, 30))
    spanning = api.post("/allocations", _allocation(ids, "jo", 40, 0, 30))
    assert "warning" not in spanning.body  # never more than 90% on any single day
    clash = api.post("/allocations", _allocation(ids, "jo", 20, 25, 40))
    assert clash.body["total_allocation_pct"] == 110


def test_update_can_trigger_the_warning(api, ids) -> None:
    created = api.post("/allocations", _allocation(ids, "ben", 5, 0, 10)).body
    result = api.put(f"/allocations/{created['id']}", {"allocation_pct": 30})
    assert result.status == 200
    assert result.body["total_allocation_pct"] == 120


@pytest.mark.parametrize(
    ("change", "fields"),
    [
        ({"allocation_pct": 0}, {"allocation_pct"}),
        ({"allocation_pct": 101}, {"allocation_pct"}),
        ({"allocation_pct": True}, {"allocation_pct"}),
        ({"end_date": "2000-01-01"}, {"end_date"}),
        ({"resource_id": 999999, "project_id": 888888}, {"resource_id", "project_id"}),
    ],
)
def test_validation(api, ids, change: dict, fields: set) -> None:
    result = api.post("/allocations", {**_allocation(ids, "ben", 10, 0, 10), **change})
    assert result.status == 400
    assert result.fields == fields


def test_required_fields(api) -> None:
    assert api.post("/allocations", {}).fields == {
        "resource_id", "project_id", "allocation_pct", "start_date", "end_date",
    }


def test_update_checks_date_order_against_stored_values(api, ids) -> None:
    created = api.post("/allocations", _allocation(ids, "ben", 5, 0, 10)).body
    result = api.put(f"/allocations/{created['id']}", {"start_date": _day(30)})
    assert result.status == 400
    assert result.fields == {"end_date"}


def test_get_delete_and_roles(api, ids) -> None:
    created = api.post("/allocations", _allocation(ids, "ben", 5, 0, 10)).body
    item = f"/allocations/{created['id']}"
    assert api.get(item, role="viewer").status == 200
    assert api.post("/allocations", _allocation(ids, "ben", 5, 0, 10), role="viewer").status == 403
    assert api.delete(item, role="contributor").status == 403
    assert api.delete(item, role="manager").status == 204
    assert api.get(item).status == 404
