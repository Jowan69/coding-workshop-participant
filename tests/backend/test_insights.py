"""Insights: the seed story, the rule boundaries, bad data, an empty database and roles."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

import pytest

from conftest import id_of

INSIGHT_PATHS = (
    "/insights/project-status",
    "/insights/at-risk",
    "/insights/allocation",
    "/insights/deliverables",
    "/insights/over-allocated",
    "/insights/dependencies",
    "/insights/budget",
    "/insights/summary",
)


@pytest.fixture
def today(conn) -> date:
    return conn.execute("SELECT CURRENT_DATE AS today").fetchone()["today"]


def _day(today: date, offset: int) -> str:
    return (today + timedelta(days=offset)).isoformat()


def _project(conn, today, name, start, end, *, status="active", budget=0) -> int:
    return conn.execute(
        "INSERT INTO projects (name, department, status, start_date, end_date, budget_planned) "
        "VALUES (%s, 'Test', %s, %s, %s, %s) RETURNING id",
        (name, status, today + timedelta(days=start), today + timedelta(days=end), budget),
    ).fetchone()["id"]


def _deliverable(conn, today, project_id, title, status, due) -> int:
    completed = None
    if status == "done":
        completed = datetime.combine(today, time(9), timezone.utc)
    return conn.execute(
        "INSERT INTO deliverables (project_id, title, status, due_date, completed_at) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (project_id, title, status, today + timedelta(days=due), completed),
    ).fetchone()["id"]


def _deliverables(conn, today, project_id, done, open_, *, due=40) -> None:
    for index in range(done):
        _deliverable(conn, today, project_id, f"Done {index}", "done", -1)
    for index in range(open_):
        _deliverable(conn, today, project_id, f"Open {index}", "in_progress", due)


def _resource(conn, name, capacity=100, *, active=True) -> int:
    email = name.lower().replace(" ", ".") + "@example.test"
    return conn.execute(
        "INSERT INTO resources (full_name, email, capacity_pct, is_active) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (name, email, capacity, active),
    ).fetchone()["id"]


def _allocate(conn, today, resource_id, project_id, pct, start, end) -> None:
    conn.execute(
        "INSERT INTO allocations (resource_id, project_id, allocation_pct, start_date, end_date) "
        "VALUES (%s, %s, %s, %s, %s)",
        (resource_id, project_id, pct, today + timedelta(days=start),
         today + timedelta(days=end)),
    )


def _link(conn, deliverable_id, depends_on_id) -> None:
    """Insert a dependency directly, bypassing the API's checks (to plant bad data)."""
    conn.execute(
        "INSERT INTO deliverable_dependencies (deliverable_id, depends_on_id) VALUES (%s, %s)",
        (deliverable_id, depends_on_id),
    )


def _by_name(items, key="name"):
    return {item[key]: item for item in items}


def _deliverable_id(conn, title) -> int:
    return id_of(conn, "deliverables", "title", title)


# Project status and health


def test_project_status_lists_open_projects_with_health(api, today) -> None:
    result = api.get("/insights/project-status", role="viewer")
    assert result.status == 200
    assert result.body["as_of"] == today.isoformat()
    items = result.body["items"]
    assert [item["health"] for item in items] == [
        "overdue", "at_risk", "at_risk", "on_track", "on_track",
    ]
    projects = _by_name(items)
    assert set(projects) == {
        "Data Center Migration", "Mobile Banking App", "Brand Refresh Campaign",
        "Customer Portal Revamp", "Market Expansion Study",
    }
    migration = projects["Data Center Migration"]
    assert migration["status"] == "active"
    assert migration["days_to_deadline"] == -10
    assert migration["deliverables_total"] == 4
    assert migration["deliverables_done"] == 2
    assert migration["percent_done"] == 50.0
    assert migration["time_elapsed_pct"] == 100.0
    assert projects["Market Expansion Study"]["status"] == "planned"
    assert projects["Market Expansion Study"]["time_elapsed_pct"] == 0.0
    assert projects["Customer Portal Revamp"]["health"] == "on_track"


def test_at_risk_returns_reasons_and_forecast(api, today) -> None:
    items = api.get("/insights/at-risk", role="viewer").body["items"]
    assert [item["name"] for item in items] == [
        "Data Center Migration", "Mobile Banking App", "Brand Refresh Campaign",
    ]
    reasons = {item["name"]: [r["code"] for r in item["reasons"]] for item in items}
    assert reasons == {
        "Data Center Migration": ["deadline_passed", "overdue_deliverables", "behind_schedule"],
        "Mobile Banking App": ["overdue_deliverables", "blocked_deliverables", "behind_schedule"],
        "Brand Refresh Campaign": ["behind_schedule"],
    }
    projects = _by_name(items)
    migration = projects["Data Center Migration"]
    assert migration["health"] == "overdue"
    assert [r["message"] for r in migration["reasons"]] == [
        "Deadline passed 10 days ago",
        "2 deliverables past due",
        "100% of time elapsed, 50% of deliverables done",
    ]
    assert projects["Mobile Banking App"]["reasons"][1]["message"] == "1 deliverable blocked"
    assert projects["Brand Refresh Campaign"]["reasons"][0]["message"] == (
        "62.5% of time elapsed, 33.3% of deliverables done"
    )
    # start + days elapsed x total / done
    assert migration["forecast_end_date"] == _day(today, -150 + 150 * 4 // 2)
    assert projects["Mobile Banking App"]["forecast_end_date"] == _day(today, -90 + 90 * 5)
    assert projects["Brand Refresh Campaign"]["forecast_end_date"] == _day(today, -75 + 75 * 3)


@pytest.mark.parametrize(
    ("start", "end", "at_risk"),
    [(-50, 50, False), (-51, 49, True)],
    ids=["exactly-20-points-is-not-slip", "21-points-is-slip"],
)
def test_schedule_slip_boundary(api, conn, today, start, end, at_risk) -> None:
    project = _project(conn, today, "Slip check", start, end)
    _deliverables(conn, today, project, done=3, open_=7)  # 30% done

    status = _by_name(api.get("/insights/project-status").body["items"])["Slip check"]
    assert status["percent_done"] == 30.0
    assert status["time_elapsed_pct"] == (51.0 if at_risk else 50.0)
    flagged = _by_name(api.get("/insights/at-risk").body["items"])
    assert ("Slip check" in flagged) is at_risk
    if at_risk:
        assert status["health"] == "at_risk"
        assert [r["code"] for r in flagged["Slip check"]["reasons"]] == ["behind_schedule"]
    else:
        assert status["health"] == "on_track"


@pytest.mark.parametrize(
    ("deliverable", "code", "health", "message"),
    [
        (None, "deadline_passed", "overdue", "Deadline passed 1 day ago"),
        (("in_progress", -1), "overdue_deliverables", "at_risk", "1 deliverable past due"),
        (("blocked", 5), "blocked_deliverables", "at_risk", "1 deliverable blocked"),
    ],
    ids=["deadline", "overdue-deliverable", "blocked-deliverable"],
)
def test_each_reason_alone(api, conn, today, deliverable, code, health, message) -> None:
    if deliverable is None:
        project = _project(conn, today, "Lone reason", -30, -1)
    else:
        project = _project(conn, today, "Lone reason", -10, 100)
        _deliverable(conn, today, project, "Only item", *deliverable)

    item = _by_name(api.get("/insights/at-risk").body["items"])["Lone reason"]
    assert item["health"] == health
    assert item["reasons"] == [{"code": code, "message": message}]


def test_closed_projects_are_never_at_risk(api, conn, today) -> None:
    for status in ("completed", "cancelled"):
        project = _project(conn, today, f"Closed {status}", -100, -20, status=status)
        _deliverable(conn, today, project, "Never finished", "blocked", -30)

    names = {item["name"] for item in api.get("/insights/at-risk").body["items"]}
    listed = {item["name"] for item in api.get("/insights/project-status").body["items"]}
    assert not names & {"Closed completed", "Closed cancelled"}
    assert not listed & {"Closed completed", "Closed cancelled"}
    assert "ERP Finance Upgrade" not in listed


def test_projects_without_deliverables_and_one_day_projects(api, conn, today) -> None:
    _project(conn, today, "No deliverables", -50, 50)
    _project(conn, today, "One day today", 0, 0)
    _project(conn, today, "One day later", 5, 5)

    projects = _by_name(api.get("/insights/project-status").body["items"])
    empty = projects["No deliverables"]
    assert empty["percent_done"] is None
    assert empty["health"] == "on_track"
    assert projects["One day today"]["time_elapsed_pct"] == 100.0
    assert projects["One day today"]["days_to_deadline"] == 0
    assert projects["One day today"]["health"] == "on_track"
    assert projects["One day later"]["time_elapsed_pct"] == 0.0


def test_forecast_waits_for_the_first_done_deliverable(api, conn, today) -> None:
    project = _project(conn, today, "Forecast", -20, 80)
    _deliverable(conn, today, project, "Stuck", "blocked", 10)
    first = _deliverable(conn, today, project, "First", "in_progress", 20)
    _deliverables(conn, today, project, done=0, open_=2)

    item = _by_name(api.get("/insights/at-risk").body["items"])["Forecast"]
    assert item["forecast_end_date"] is None

    conn.execute(
        "UPDATE deliverables SET status = 'done', completed_at = now() WHERE id = %s", (first,)
    )
    item = _by_name(api.get("/insights/at-risk").body["items"])["Forecast"]
    assert item["forecast_end_date"] == _day(today, -20 + 20 * 4)  # 1 of 4 done in 20 days


# Allocation matrix


def test_allocation_matrix_today(api, today) -> None:
    result = api.get("/insights/allocation", role="viewer")
    assert result.status == 200
    body = result.body
    assert body["on"] == today.isoformat()
    assert [p["name"] for p in body["projects"]] == [
        "Brand Refresh Campaign", "Customer Portal Revamp", "Data Center Migration",
        "Mobile Banking App",
    ]
    projects = {p["name"]: p["id"] for p in body["projects"]}
    people = _by_name(body["resources"], "full_name")
    assert len(people) == 8
    aisha = people["Aisha Khan"]
    assert aisha["total_pct"] == 120
    assert aisha["over_capacity"] is True
    assert {c["project_id"]: c["allocation_pct"] for c in aisha["cells"]} == {
        projects["Customer Portal Revamp"]: 60, projects["Mobile Banking App"]: 60,
    }
    assert people["Emma Wilson"] == {
        "id": people["Emma Wilson"]["id"], "full_name": "Emma Wilson", "capacity_pct": 100,
        "total_pct": 0, "cells": [], "over_capacity": False,
    }
    assert people["Grace Liu"]["capacity_pct"] == 50
    assert people["Grace Liu"]["over_capacity"] is False


def test_allocation_matrix_on_another_day(api, today) -> None:
    body = api.get("/insights/allocation", query={"on": _day(today, 25)}).body
    assert body["on"] == _day(today, 25)
    names = [p["name"] for p in body["projects"]]
    assert "Market Expansion Study" in names
    assert "Data Center Migration" not in names
    people = _by_name(body["resources"], "full_name")
    assert people["Farid Haddad"]["total_pct"] == 50
    assert people["Diego Alvarez"]["total_pct"] == 100
    assert people["Diego Alvarez"]["over_capacity"] is False


def test_allocation_rows_for_inactive_people(api, conn, today) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    _resource(conn, "Idle Leaver", active=False)
    busy = _resource(conn, "Busy Leaver", active=False)
    _allocate(conn, today, busy, portal, 20, -5, 5)

    people = _by_name(api.get("/insights/allocation").body["resources"], "full_name")
    assert "Idle Leaver" not in people
    assert people["Busy Leaver"]["total_pct"] == 20


def test_allocation_rejects_a_bad_date(api) -> None:
    result = api.get("/insights/allocation", query={"on": "2026-02-30"})
    assert result.status == 400
    assert result.fields == {"on"}


# Deliverables


def test_deliverable_progress_per_project(api, today) -> None:
    items = api.get("/insights/deliverables", role="viewer").body["items"]
    assert [item["project_name"] for item in items][:2] == [
        "Data Center Migration", "Mobile Banking App",
    ]
    projects = _by_name(items, "project_name")
    assert "ERP Finance Upgrade" not in projects
    banking = projects["Mobile Banking App"]
    assert banking["counts"] == {"not_started": 2, "in_progress": 1, "blocked": 1, "done": 1}
    assert banking["total"] == 5
    assert banking["percent_done"] == 20.0
    assert banking["overdue"] == 2
    assert banking["next_due"]["title"] == "Security review"
    assert banking["next_due"]["due_date"] == _day(today, 10)
    assert banking["next_due"]["status"] == "not_started"
    assert projects["Data Center Migration"]["next_due"] is None
    assert projects["Data Center Migration"]["overdue"] == 2


# Over-allocation


def test_over_allocated_people_in_the_seed(api, today) -> None:
    body = api.get("/insights/over-allocated", role="viewer").body
    assert body["from"] == today.isoformat()
    assert body["to"] == _day(today, 90)
    assert [item["full_name"] for item in body["items"]] == ["Aisha Khan", "Farid Haddad"]
    aisha, farid = body["items"]
    assert aisha["peak_pct"] == 120
    assert aisha["capacity_pct"] == 100
    assert aisha["peak_on"] == today.isoformat()
    assert (aisha["overlap_start"], aisha["overlap_end"]) == (_day(today, -60), _day(today, 30))
    assert [(p["project_name"], p["allocation_pct"]) for p in aisha["projects"]] == [
        ("Customer Portal Revamp", 60), ("Mobile Banking App", 60),
    ]
    assert (farid["overlap_start"], farid["overlap_end"]) == (_day(today, -20), _day(today, 20))


@pytest.mark.parametrize(
    ("capacity", "first", "second", "peak"),
    [(100, 60, 40, None), (100, 60, 41, 101), (50, 30, 20, None), (50, 30, 21, 51)],
    ids=["exactly-100", "101", "exactly-capacity-50", "above-capacity-50"],
)
def test_over_allocation_boundary(api, conn, today, capacity, first, second, peak) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    banking = id_of(conn, "projects", "name", "Mobile Banking App")
    person = _resource(conn, "Edge Case", capacity)
    _allocate(conn, today, person, portal, first, 0, 30)
    _allocate(conn, today, person, banking, second, 10, 40)

    people = _by_name(api.get("/insights/over-allocated").body["items"], "full_name")
    if peak is None:
        assert "Edge Case" not in people
    else:
        assert people["Edge Case"]["peak_pct"] == peak
        assert people["Edge Case"]["peak_on"] == _day(today, 10)
        assert (people["Edge Case"]["overlap_start"], people["Edge Case"]["overlap_end"]) == (
            _day(today, 10), _day(today, 30),
        )


def test_over_allocation_window_checkpoints(api, conn, today) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    banking = id_of(conn, "projects", "name", "Mobile Banking App")
    inside = _resource(conn, "Starts Inside")
    _allocate(conn, today, inside, portal, 60, -10, 60)
    _allocate(conn, today, inside, banking, 50, 30, 40)
    later = _resource(conn, "Starts Later")
    _allocate(conn, today, later, portal, 60, -10, 120)
    _allocate(conn, today, later, banking, 50, 100, 110)
    apart = _resource(conn, "Never Overlaps")
    _allocate(conn, today, apart, portal, 60, 0, 10)
    _allocate(conn, today, apart, banking, 60, 11, 20)

    people = _by_name(api.get("/insights/over-allocated").body["items"], "full_name")
    assert people["Starts Inside"]["peak_pct"] == 110
    assert people["Starts Inside"]["peak_on"] == _day(today, 30)
    assert people["Starts Inside"]["overlap_end"] == _day(today, 40)
    assert "Starts Later" not in people
    assert "Never Overlaps" not in people

    wider = api.get("/insights/over-allocated", query={"to": _day(today, 100)}).body
    assert _by_name(wider["items"], "full_name")["Starts Later"]["peak_on"] == _day(today, 100)

    after = api.get("/insights/over-allocated", query={"from": _day(today, 50)}).body
    assert after["to"] == _day(today, 140)
    assert "Starts Inside" not in _by_name(after["items"], "full_name")


@pytest.mark.parametrize(
    ("query", "field"),
    [
        ({"from": "next week"}, "from"),
        ({"to": "2026-13-01"}, "to"),
        ({"from": "2026-06-10", "to": "2026-06-09"}, "to"),
    ],
)
def test_over_allocated_rejects_bad_windows(api, query, field) -> None:
    result = api.get("/insights/over-allocated", query=query)
    assert result.status == 400
    assert result.fields == {field}


# Dependencies


def test_dependency_chain_three_deep(api, conn) -> None:
    banking = id_of(conn, "projects", "name", "Mobile Banking App")
    ids = {
        title: _deliverable_id(conn, title)
        for title in ("API contract", "Payments integration", "Security review",
                      "App store submission", "Push notifications")
    }
    body = api.get("/insights/dependencies", query={"project_id": banking}, role="viewer").body
    assert body["project_id"] == banking
    assert body["project_name"] == "Mobile Banking App"
    items = _by_name(body["items"], "title")
    assert {title: item["depth"] for title, item in items.items()} == {
        "API contract": 0, "Push notifications": 0, "Payments integration": 1,
        "Security review": 2, "App store submission": 3,
    }
    assert [item["depth"] for item in body["items"]] == [0, 0, 1, 2, 3]
    store = items["App store submission"]
    assert store["upstream_ids"] == sorted(
        [ids["API contract"], ids["Payments integration"], ids["Security review"]]
    )
    assert store["depends_on_ids"] == [ids["Security review"]]
    assert {title: item["blocked_by_upstream"] for title, item in items.items()} == {
        "API contract": False, "Push notifications": False, "Payments integration": False,
        "Security review": True, "App store submission": True,
    }
    assert body["longest_chain"] == [
        ids["API contract"], ids["Payments integration"], ids["Security review"],
        ids["App store submission"],
    ]
    assert "chain_to_root" not in store


def test_dependency_chain_diamond(api, conn, today) -> None:
    project = _project(conn, today, "Diamond", -10, 50)
    a = _deliverable(conn, today, project, "A", "done", 0)
    b = _deliverable(conn, today, project, "B", "blocked", 10)
    c = _deliverable(conn, today, project, "C", "in_progress", 10)
    d = _deliverable(conn, today, project, "D", "not_started", 20)
    for item, upstream in ((b, a), (c, a), (d, b), (d, c)):
        _link(conn, item, upstream)

    body = api.get("/insights/dependencies", query={"project_id": project}).body
    items = _by_name(body["items"], "title")
    assert items["D"]["depth"] == 2
    assert items["D"]["upstream_ids"] == sorted([a, b, c])
    assert items["D"]["depends_on_ids"] == sorted([b, c])
    assert items["D"]["blocked_by_upstream"] is True
    assert items["C"]["blocked_by_upstream"] is False
    assert body["longest_chain"] == [a, b, d]


def test_dependency_chain_ends_on_a_cycle(api, conn, today) -> None:
    project = _project(conn, today, "Cyclic", -10, 50)
    one, two, three, four = (
        _deliverable(conn, today, project, title, "not_started", 10)
        for title in ("One", "Two", "Three", "Four")
    )
    for item, upstream in ((two, one), (three, two), (one, three), (four, three)):
        _link(conn, item, upstream)
    _link(conn, one, _deliverable_id(conn, "API contract"))  # another project: ignored

    result = api.get("/insights/dependencies", query={"project_id": project})
    assert result.status == 200
    items = _by_name(result.body["items"], "title")
    assert {title: item["depth"] for title, item in items.items()} == {
        "One": 2, "Two": 2, "Three": 2, "Four": 3,
    }
    assert items["One"]["upstream_ids"] == sorted([two, three])
    assert items["One"]["depends_on_ids"] == [three]
    assert result.body["longest_chain"] == [one, two, three, four]


def test_dependency_chain_of_a_project_without_deliverables(api, conn, today) -> None:
    project = _project(conn, today, "Bare", 0, 10)
    body = api.get("/insights/dependencies", query={"project_id": project}).body
    assert body["items"] == []
    assert body["longest_chain"] == []


@pytest.mark.parametrize(
    ("query", "status"),
    [({}, 400), ({"project_id": ""}, 400), ({"project_id": "abc"}, 400),
     ({"project_id": "999999"}, 404)],
)
def test_dependency_chain_needs_a_real_project(api, query, status) -> None:
    result = api.get("/insights/dependencies", query=query)
    assert result.status == status
    if status == 400:
        assert result.fields == {"project_id"}


# Budget and summary


def test_budget_planned_spent_and_burn(api) -> None:
    items = api.get("/insights/budget", role="viewer").body["items"]
    assert len(items) == 6
    brand = items[0]
    assert brand == {
        "project_id": brand["project_id"], "project_name": "Brand Refresh Campaign",
        "project_status": "active", "planned": 80000.0, "spent": 96500.0,
        "remaining": -16500.0, "percent_used": 120.6, "over_budget": True,
        "time_elapsed_pct": 62.5, "burn_gap_pts": 58.1,
    }
    projects = _by_name(items, "project_name")
    assert projects["ERP Finance Upgrade"]["project_status"] == "completed"
    assert projects["ERP Finance Upgrade"]["over_budget"] is False
    assert projects["Market Expansion Study"]["percent_used"] == 0.0
    assert [p["project_name"] for p in items if p["over_budget"]] == ["Brand Refresh Campaign"]


def test_budget_without_a_planned_amount(api, conn, today) -> None:
    project = _project(conn, today, "Unplanned", -10, 10)
    item = _by_name(api.get("/insights/budget").body["items"], "project_name")["Unplanned"]
    assert item["percent_used"] is None
    assert item["burn_gap_pts"] is None
    assert item["over_budget"] is False
    assert api.get("/insights/budget").body["items"][-1]["project_name"] == "Unplanned"

    conn.execute(
        "INSERT INTO budget_entries (project_id, category, amount, spent_on) "
        "VALUES (%s, 'other', 10, %s)",
        (project, today),
    )
    item = _by_name(api.get("/insights/budget").body["items"], "project_name")["Unplanned"]
    assert item["over_budget"] is True
    assert item["remaining"] == -10.0


def test_summary_headline_counts(api, today) -> None:
    result = api.get("/insights/summary", role="viewer")
    assert result.status == 200
    assert result.body == {
        "as_of": today.isoformat(),
        "active_projects": 4,
        "at_risk_projects": 3,
        "overdue_deliverables": 4,
        "over_allocated_people": 2,
        "over_budget_projects": 1,
    }


# Empty database and roles


def test_every_insight_answers_on_an_empty_database(api, conn) -> None:
    conn.execute("DELETE FROM projects")
    conn.execute("DELETE FROM resources")

    for path in ("/insights/project-status", "/insights/at-risk", "/insights/deliverables",
                 "/insights/over-allocated", "/insights/budget"):
        result = api.get(path, role="viewer")
        assert result.status == 200, path
        assert result.body["items"] == [], path
    allocation = api.get("/insights/allocation").body
    assert (allocation["projects"], allocation["resources"]) == ([], [])
    summary = api.get("/insights/summary").body
    assert {key: value for key, value in summary.items() if key != "as_of"} == {
        "active_projects": 0, "at_risk_projects": 0, "overdue_deliverables": 0,
        "over_allocated_people": 0, "over_budget_projects": 0,
    }
    assert api.get("/insights/dependencies", query={"project_id": 1}).status == 404


@pytest.mark.parametrize("path", INSIGHT_PATHS)
def test_insights_are_read_only_for_every_signed_in_role(api, conn, path) -> None:
    query = {}
    if path.endswith("/dependencies"):
        query = {"project_id": id_of(conn, "projects", "name", "Mobile Banking App")}
    for role in ("viewer", "contributor", "manager", "admin"):
        assert api.get(path, role=role, query=query).status == 200, role
    unauthenticated = api.get(path, role=None, query=query)
    assert unauthenticated.status == 401
    assert unauthenticated.error["code"] == "missing_token"


def test_insights_have_no_write_routes(api) -> None:
    for method in ("POST", "PUT", "DELETE"):
        result = api.call(method, "/insights/summary", body={})
        assert result.status == 404
        assert result.error["code"] == "route_not_found"
