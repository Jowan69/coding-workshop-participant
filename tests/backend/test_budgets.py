"""Budget entries: CRUD, created_by from the token, filters and the summary."""

from __future__ import annotations

import pytest

from conftest import id_of


@pytest.fixture
def project_ids(conn):
    return {
        "brand": id_of(conn, "projects", "name", "Brand Refresh Campaign"),
        "portal": id_of(conn, "projects", "name", "Customer Portal Revamp"),
        "study": id_of(conn, "projects", "name", "Market Expansion Study"),
    }


def _entry(project_id: int, **change):
    return {"project_id": project_id, "category": "software", "amount": 1999.99,
            "spent_on": "2026-11-01", "description": "Licences", **change}


def test_list_filters_and_default_sort(api, project_ids) -> None:
    everything = api.get("/budgets", role="viewer").body
    assert everything["total"] == 20
    spent = [e["spent_on"] for e in everything["items"]]
    assert spent == sorted(spent, reverse=True)
    assert api.get("/budgets", query={"project_id": project_ids["brand"]}).body["total"] == 4
    assert api.get("/budgets", query={"category": "hardware"}).body["total"] == 3
    oldest = everything["items"][-1]["spent_on"]
    assert api.get("/budgets", query={"spent_to": oldest}).body["total"] == 1
    assert api.get("/budgets", query={"spent_from": spent[0]}).body["total"] == 1
    biggest = api.get("/budgets", query={"sort": "-amount", "limit": 1}).body["items"][0]
    assert biggest["amount"] == 120000.0
    assert api.get("/budgets", query={"category": "travel"}).status == 400


def test_create_takes_created_by_from_the_token(api, conn, project_ids) -> None:
    lead = id_of(conn, "users", "email", "lead@acme.test")
    admin = id_of(conn, "users", "email", "admin@acme.test")
    body = _entry(project_ids["portal"], created_by=admin)
    result = api.post("/budgets", body, role="contributor")
    assert result.status == 201
    assert result.body["created_by"] == lead
    assert result.body["amount"] == 1999.99


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"amount": 0}, "amount"),
        ({"amount": -5}, "amount"),
        ({"amount": 1.005}, "amount"),
        ({"amount": "12"}, "amount"),
        ({"category": "travel"}, "category"),
        ({"spent_on": None}, "spent_on"),
        ({"project_id": 999999}, "project_id"),
        ({"description": "x" * 501}, "description"),
    ],
)
def test_validation(api, project_ids, change: dict, field: str) -> None:
    result = api.post("/budgets", {**_entry(project_ids["portal"]), **change})
    assert result.status == 400
    assert result.fields == {field}


def test_update_get_delete_and_roles(api, project_ids) -> None:
    created = api.post("/budgets", _entry(project_ids["portal"])).body
    item = f"/budgets/{created['id']}"
    assert api.put(item, {"amount": 2500}, role="contributor").body["amount"] == 2500.0
    assert api.get(item, role="viewer").status == 200
    assert api.put(item, {"amount": 1}, role="viewer").status == 403
    assert api.delete(item, role="contributor").status == 403
    assert api.delete(item, role="manager").status == 204
    assert api.get(item).status == 404


def test_summary_of_an_over_budget_project(api, project_ids) -> None:
    result = api.get("/budgets/summary", query={"project_id": project_ids["brand"]}, role="viewer")
    assert result.status == 200
    assert result.body == {
        "project_id": project_ids["brand"],
        "project_name": "Brand Refresh Campaign",
        "planned": 80000.0,
        "spent": 96500.0,
        "remaining": -16500.0,
        "percent_used": 120.6,
    }


def test_summary_without_spending_or_plan(api, project_ids) -> None:
    study = api.get("/budgets/summary", query={"project_id": project_ids["study"]}).body
    assert (study["spent"], study["remaining"], study["percent_used"]) == (0.0, 60000.0, 0.0)
    free = api.post("/projects", {"name": "Volunteer Day", "department": "Operations",
                                  "start_date": "2026-01-01", "end_date": "2026-01-02"}).body
    unplanned = api.get("/budgets/summary", query={"project_id": free["id"]}).body
    assert unplanned["percent_used"] is None


def test_summary_errors(api) -> None:
    assert api.get("/budgets/summary").status == 400
    assert api.get("/budgets/summary", query={"project_id": "abc"}).status == 400
    assert api.get("/budgets/summary", query={"project_id": 999999}).status == 404
    assert api.get("/budgets/summary", query={"project_id": 1}, role=None).status == 401
