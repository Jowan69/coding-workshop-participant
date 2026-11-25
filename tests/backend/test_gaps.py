"""Phase 6, part A: gaps against the brief (budget search, project-status filter and forecast)."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from conftest import id_of


@pytest.fixture
def today(conn) -> date:
    return conn.execute("SELECT CURRENT_DATE AS today").fetchone()["today"]


# A1: budget entries are searchable by description


def test_budget_entries_search_their_description(api, conn) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    found = api.get("/budgets", query={"q": "LICENCES"}, role="viewer").body
    assert {entry["description"] for entry in found["items"]} == {
        "Single sign-on licences", "ERP upgrade licences",
    }
    scoped = api.get("/budgets", query={"q": "licences", "project_id": portal}).body
    assert [entry["description"] for entry in scoped["items"]] == ["Single sign-on licences"]
    assert api.get("/budgets", query={"q": "no such entry"}).body["total"] == 0


def test_budget_search_treats_wildcards_literally(api) -> None:
    assert api.get("/budgets", query={"q": "%"}).body["total"] == 0
    assert api.get("/budgets", query={"q": "_"}).body["total"] == 0


# A4: /insights/project-status?status=


def test_project_status_without_a_status_lists_every_open_project(api) -> None:
    items = api.get("/insights/project-status", role="viewer").body["items"]
    assert {item["status"] for item in items} == {"active", "planned"}
    assert len(items) == 5


@pytest.mark.parametrize(
    ("status", "names"),
    [
        ("active", ["Data Center Migration", "Mobile Banking App", "Brand Refresh Campaign",
                    "Customer Portal Revamp"]),
        ("planned", ["Market Expansion Study"]),
        ("on_hold", []),
    ],
)
def test_project_status_filters_by_one_open_status(api, status: str, names: list[str]) -> None:
    result = api.get("/insights/project-status", query={"status": status}, role="viewer")
    assert result.status == 200
    assert [item["name"] for item in result.body["items"]] == names
    assert all(item["status"] == status for item in result.body["items"])


def test_project_status_ignores_a_blank_status(api) -> None:
    assert len(api.get("/insights/project-status", query={"status": ""}).body["items"]) == 5


@pytest.mark.parametrize("status", ["completed", "cancelled", "late", "ACTIVE"])
def test_project_status_rejects_closed_and_unknown_statuses(api, status: str) -> None:
    result = api.get("/insights/project-status", query={"status": status})
    assert result.status == 400
    assert result.fields == {"status"}
    assert "planned, active, on_hold" in result.error["details"][0]["message"]


# A5: forecast_end_date on every project-status item


def test_project_status_items_carry_the_forecast_end_date(api, today) -> None:
    items = api.get("/insights/project-status", role="viewer").body["items"]
    assert all("forecast_end_date" in item for item in items)
    forecasts = {item["name"]: item["forecast_end_date"] for item in items}
    # start + days elapsed x total / done, as /insights/at-risk reports it
    assert forecasts["Data Center Migration"] == (today + timedelta(days=150)).isoformat()
    assert forecasts["Customer Portal Revamp"] == (today + timedelta(days=60)).isoformat()
    # nothing done yet: no forecast
    assert forecasts["Market Expansion Study"] is None


def test_at_risk_and_project_status_agree_on_the_forecast(api) -> None:
    status = {item["id"]: item for item in api.get("/insights/project-status").body["items"]}
    for item in api.get("/insights/at-risk").body["items"]:
        assert item["forecast_end_date"] == status[item["id"]]["forecast_end_date"]
        assert set(item) == set(status[item["id"]]) | {"reasons"}
