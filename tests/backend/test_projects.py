"""Projects: CRUD, validation, filters, search, sorting, pagination, figures and roles."""

from __future__ import annotations

import pytest

from conftest import id_of

PROJECT = {
    "name": "Warehouse Robotics Pilot",
    "department": "Operations",
    "description": "Trial pick-and-place robots in one warehouse.",
    "start_date": "2026-01-01",
    "end_date": "2026-06-30",
    "budget_planned": 125000.5,
}


def test_list_projects(api) -> None:
    result = api.get("/projects", role="viewer")
    assert result.status == 200
    assert result.body["total"] == 6
    assert result.body["limit"] == 50 and result.body["offset"] == 0
    names = [p["name"] for p in result.body["items"]]
    assert names == sorted(names)
    assert set(result.body["items"][0]) >= {"id", "status", "end_date", "budget_planned"}


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ({"status": "active"}, 4),
        ({"department": "Marketing"}, 2),
        ({"q": "migration"}, 1),
        ({"q": "MOBILE banking"}, 1),
        ({"q": "self-service"}, 1),
        ({"q": "100%_"}, 0),
        ({"status": "active", "department": "Engineering"}, 2),
    ],
)
def test_project_filters_and_search(api, query: dict, expected: int) -> None:
    assert api.get("/projects", query=query).body["total"] == expected


def test_filter_by_owner(api, conn) -> None:
    lead_id = id_of(conn, "users", "email", "lead@acme.test")
    names = {p["name"] for p in api.get("/projects", query={"owner_id": lead_id}).body["items"]}
    assert names == {"Mobile Banking App", "Market Expansion Study"}


def test_sorting(api) -> None:
    by_deadline = api.get("/projects", query={"sort": "end_date"}).body["items"]
    assert [p["end_date"] for p in by_deadline] == sorted(p["end_date"] for p in by_deadline)
    latest = api.get("/projects", query={"sort": "-end_date"}).body["items"][0]
    assert latest["name"] == "Market Expansion Study"
    by_status = api.get("/projects", query={"sort": "status"}).body["items"]
    assert by_status[0]["status"] == "active"


def test_pagination(api) -> None:
    first = api.get("/projects", query={"limit": 4}).body
    second = api.get("/projects", query={"limit": 4, "offset": 4}).body
    assert (first["total"], len(first["items"]), len(second["items"])) == (6, 4, 2)
    assert not {p["id"] for p in first["items"]} & {p["id"] for p in second["items"]}
    assert api.get("/projects", query={"limit": 1000}).body["limit"] == 100


@pytest.mark.parametrize(
    "query",
    [{"limit": 0}, {"limit": "ten"}, {"offset": -1}, {"sort": "budget"}, {"status": "late"},
     {"owner_id": "me"}],
)
def test_bad_list_parameters(api, query: dict) -> None:
    result = api.get("/projects", query=query)
    assert result.status == 400
    assert result.fields == set(query)


def test_project_detail_has_delivery_and_budget_figures(api, conn) -> None:
    project_id = id_of(conn, "projects", "name", "Mobile Banking App")
    result = api.get(f"/projects/{project_id}", role="viewer")
    assert result.status == 200
    assert result.body["deliverable_counts"] == {
        "not_started": 2, "in_progress": 1, "blocked": 1, "done": 1,
    }
    assert result.body["deliverables_total"] == 5
    assert result.body["percent_complete"] == 20.0
    assert result.body["budget_spent"] == 103500.0


def test_detail_of_a_project_without_deliverables(api) -> None:
    created = api.post("/projects", PROJECT).body
    detail = api.get(f"/projects/{created['id']}").body
    assert detail["percent_complete"] == 0.0
    assert detail["budget_spent"] == 0.0


def test_unknown_project_is_404(api) -> None:
    result = api.get("/projects/999999")
    assert result.status == 404
    assert result.error["code"] == "not_found"


def test_create_project(api) -> None:
    result = api.post("/projects", PROJECT, role="contributor")
    assert result.status == 201
    assert result.body["status"] == "planned"
    assert result.body["budget_planned"] == 125000.5
    assert result.body["owner_id"] is None
    assert api.get(f"/projects/{result.body['id']}").status == 200


def test_create_requires_fields_all_at_once(api) -> None:
    result = api.post("/projects", {})
    assert result.status == 400
    assert result.fields == {"name", "department", "start_date", "end_date"}


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"end_date": "2025-12-31"}, "end_date"),
        ({"budget_planned": -1}, "budget_planned"),
        ({"budget_planned": None}, "budget_planned"),
        ({"start_date": "2026-13-01"}, "start_date"),
        ({"status": "late"}, "status"),
        ({"owner_id": 999999}, "owner_id"),
        ({"name": "x" * 151}, "name"),
    ],
)
def test_create_validation_rules(api, change: dict, field: str) -> None:
    result = api.post("/projects", {**PROJECT, **change})
    assert result.status == 400
    assert field in result.fields


def test_duplicate_name_is_a_conflict(api) -> None:
    result = api.post("/projects", {**PROJECT, "name": "ERP Finance Upgrade"})
    assert result.status == 409
    assert result.fields == {"name"}


def test_update_is_partial_and_checks_stored_dates(api, conn) -> None:
    project_id = id_of(conn, "projects", "name", "Customer Portal Revamp")
    result = api.put(f"/projects/{project_id}", {"status": "on_hold"}, role="contributor")
    assert result.status == 200
    assert result.body["status"] == "on_hold"
    assert result.body["name"] == "Customer Portal Revamp"
    before_start = api.put(f"/projects/{project_id}", {"end_date": "2000-01-01"})
    assert before_start.status == 400
    assert before_start.fields == {"end_date"}


def test_update_errors(api, conn) -> None:
    project_id = id_of(conn, "projects", "name", "Customer Portal Revamp")
    assert api.put(f"/projects/{project_id}", {"name": "ERP Finance Upgrade"}).status == 409
    assert api.put(f"/projects/{project_id}", {}).status == 400
    assert api.put(f"/projects/{project_id}", {"colour": "red"}).status == 400
    assert api.put("/projects/999999", {"status": "active"}).status == 404


def test_delete_cascades(api, conn) -> None:
    project_id = id_of(conn, "projects", "name", "Mobile Banking App")
    assert api.delete(f"/projects/{project_id}", role="manager").status == 204
    assert api.get(f"/projects/{project_id}").status == 404
    left = conn.execute(
        "SELECT count(*) AS n FROM deliverables WHERE project_id = %s", (project_id,)
    ).fetchone()
    assert left["n"] == 0
    assert api.delete(f"/projects/{project_id}").status == 404


def test_role_matrix(api, conn) -> None:
    project_id = id_of(conn, "projects", "name", "Customer Portal Revamp")
    item = f"/projects/{project_id}"
    assert api.get("/projects", role="viewer").status == 200
    assert api.get(item, role="viewer").status == 200
    assert api.post("/projects", PROJECT, role="viewer").status == 403
    assert api.put(item, {"status": "active"}, role="viewer").status == 403
    assert api.delete(item, role="viewer").status == 403
    assert api.put(item, {"status": "active"}, role="contributor").status == 200
    assert api.delete(item, role="contributor").status == 403
    forbidden = api.delete(item, role="contributor")
    assert forbidden.error["code"] == "forbidden"
    for method in ("GET", "POST", "PUT", "DELETE"):
        path = "/projects" if method == "POST" else item
        assert api.call(method, path, role=None, body={}).status == 401
