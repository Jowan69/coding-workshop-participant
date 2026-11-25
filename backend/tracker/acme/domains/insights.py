"""Insights: read-only answers to the business questions behind the Dashboard.

The rules and the SQL live in ``insights_sql``. This module parses query parameters, turns
query rows into responses and registers the routes. Every route is a GET, so any signed-in
role (viewer and above) may call it.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from acme.core.http import BadRequest, NotFound, Request, Response, Router, ok
from acme.core.validation import parse_param
from acme.domains import insights_sql as queries
from acme.domains.projects import STATUSES as PROJECT_STATUSES

# Fields of a project-health row that every project-status item returns
STATUS_FIELDS = (
    "id", "name", "department", "status", "start_date", "end_date", "days_to_deadline",
    "deliverables_total", "deliverables_done", "percent_done", "time_elapsed_pct", "health",
    "forecast_end_date",
)
# Statuses /insights/project-status can be narrowed to: the open ones
OPEN_PROJECT_STATUSES = tuple(
    status for status in PROJECT_STATUSES if status not in queries.CLOSED_PROJECT_STATUSES
)
DELIVERABLE_STATUSES = ("not_started", "in_progress", "blocked", "done")
BUDGET_FIELDS = (
    "project_id", "project_name", "project_status", "planned", "spent", "remaining",
    "percent_used", "over_budget", "time_elapsed_pct", "burn_gap_pts",
)


def _pick(row: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {name: row[name] for name in fields}


def _date_param(request: Request, name: str, default: date) -> date:
    """An optional ``YYYY-MM-DD`` query parameter; blank or missing gives ``default``."""
    raw = request.query.get(name, "")
    return parse_param(name, "date", raw) if raw.strip() else default


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _pct(value: Decimal) -> str:
    """62.5 -> "62.5%", 100.0 -> "100%"."""
    return f"{float(value):g}%"


def _reasons(row: dict[str, Any]) -> list[dict[str, str]]:
    """Why a project is at risk, one ``{code, message}`` per rule it breaks."""
    reasons = []
    if row["deadline_passed"]:
        days = _plural(-row["days_to_deadline"], "day")
        reasons.append({"code": "deadline_passed", "message": f"Deadline passed {days} ago"})
    if row["deliverables_overdue"]:
        count = _plural(row["deliverables_overdue"], "deliverable")
        reasons.append({"code": "overdue_deliverables", "message": f"{count} past due"})
    if row["deliverables_blocked"]:
        count = _plural(row["deliverables_blocked"], "deliverable")
        reasons.append({"code": "blocked_deliverables", "message": f"{count} blocked"})
    if row["behind_schedule"]:
        message = (
            f"{_pct(row['time_elapsed_pct'])} of time elapsed, "
            f"{_pct(row['percent_done'])} of deliverables done"
        )
        reasons.append({"code": "behind_schedule", "message": message})
    return reasons


def project_status(request: Request) -> Response:
    """Open projects with status, percent done, days to deadline, health and forecast.

    ``?status=`` narrows the answer to one open status (planned, active or on_hold).
    """
    raw = request.query.get("status", "")
    status = parse_param("status", "enum", raw, OPEN_PROJECT_STATUSES) if raw.strip() else None
    today = queries.today(request.db)
    rows = queries.project_health(request.db, today, status=status)
    return ok({"as_of": today, "items": [_pick(row, STATUS_FIELDS) for row in rows]})


def at_risk(request: Request) -> Response:
    """Open projects whose health is not on track, with reasons and a forecast end date."""
    today = queries.today(request.db)
    rows = queries.project_health(request.db, today, only_at_risk=True)
    items = [
        {**_pick(row, STATUS_FIELDS), "reasons": _reasons(row)}
        for row in rows
    ]
    return ok({"as_of": today, "items": items})


def allocation(request: Request) -> Response:
    """A person-by-project matrix of allocation percent on ``?on=`` (default today)."""
    day = _date_param(request, "on", queries.today(request.db))
    projects: dict[int, str] = {}
    people: dict[int, dict[str, Any]] = {}
    for row in queries.allocation_on(request.db, day):
        person = people.setdefault(
            row["resource_id"],
            {
                "id": row["resource_id"],
                "full_name": row["full_name"],
                "capacity_pct": row["capacity_pct"],
                "total_pct": 0,
                "cells": [],
            },
        )
        if row["project_id"] is None:
            continue
        projects[row["project_id"]] = row["project_name"]
        person["cells"].append(
            {"project_id": row["project_id"], "allocation_pct": row["allocation_pct"]}
        )
        person["total_pct"] += row["allocation_pct"]
    for person in people.values():
        person["over_capacity"] = person["total_pct"] > person["capacity_pct"]
    columns = sorted(projects.items(), key=lambda item: (item[1].lower(), item[0]))
    return ok(
        {
            "on": day,
            "projects": [{"id": pid, "name": name} for pid, name in columns],
            "resources": list(people.values()),
        }
    )


def deliverables(request: Request) -> Response:
    """Per open project: counts by status, percent done, overdue count and the next due item."""
    today = queries.today(request.db)
    items = []
    for row in queries.deliverable_progress(request.db, today):
        next_due = None
        if row["next_id"] is not None:
            next_due = {
                "id": row["next_id"],
                "title": row["next_title"],
                "status": row["next_status"],
                "due_date": row["next_due_date"],
            }
        items.append(
            {
                "project_id": row["project_id"],
                "project_name": row["project_name"],
                "project_status": row["project_status"],
                "total": row["total"],
                "counts": {status: row[status] for status in DELIVERABLE_STATUSES},
                "percent_done": row["percent_done"],
                "overdue": row["overdue"],
                "next_due": next_due,
            }
        )
    return ok({"as_of": today, "items": items})


def _window(request: Request) -> tuple[date, date]:
    """``?from=`` (default today) and ``?to=`` (default from + the look-ahead window)."""
    window_from = _date_param(request, "from", queries.today(request.db))
    default_to = window_from + timedelta(days=queries.OVER_ALLOCATION_WINDOW_DAYS)
    window_to = _date_param(request, "to", default_to)
    if window_to < window_from:
        raise BadRequest(
            "Invalid query parameter to", [{"field": "to", "message": "must be on or after from"}]
        )
    return window_from, window_to


def over_allocated(request: Request) -> Response:
    """People whose summed allocation exceeds their capacity on a day in the window."""
    window_from, window_to = _window(request)
    rows = queries.over_allocated(request.db, window_from, window_to)
    return ok({"from": window_from, "to": window_to, "items": rows})


def dependencies(request: Request) -> Response:
    """The dependency chain of ``?project_id=``: depth, upstream and blocks, longest chain."""
    raw = request.query.get("project_id", "")
    if not raw.strip():
        raise BadRequest(
            "project_id is required", [{"field": "project_id", "message": "is required"}]
        )
    project_id = parse_param("project_id", "int", raw)
    project = queries.find_project(request.db, project_id)
    if project is None:
        raise NotFound(f"Project {project_id} not found")
    rows = queries.dependency_chain(request.db, project_id)
    # Rows come shallowest first, so max() keeps the earliest-due of the deepest items.
    deepest = max(rows, key=lambda row: row["depth"], default=None)
    longest = list(reversed(deepest["chain_to_root"])) if deepest else []
    items = [{key: value for key, value in row.items() if key != "chain_to_root"} for row in rows]
    return ok(
        {
            "project_id": project["id"],
            "project_name": project["name"],
            "items": items,
            "longest_chain": longest,
        }
    )


def budget(request: Request) -> Response:
    """Per project: planned, spent, percent used, remaining, over budget, burn against time."""
    today = queries.today(request.db)
    rows = queries.budget_burn(request.db, today)
    return ok({"as_of": today, "items": [_pick(row, BUDGET_FIELDS) for row in rows]})


def summary(request: Request) -> Response:
    """Headline counts in one call, computed by the same queries as the sections."""
    conn = request.db
    today = queries.today(conn)
    window_to = today + timedelta(days=queries.OVER_ALLOCATION_WINDOW_DAYS)
    progress = queries.deliverable_progress(conn, today)
    return ok(
        {
            "as_of": today,
            "active_projects": queries.active_project_count(conn),
            "at_risk_projects": len(queries.project_health(conn, today, only_at_risk=True)),
            "overdue_deliverables": sum(row["overdue"] for row in progress),
            "over_allocated_people": len(queries.over_allocated(conn, today, window_to)),
            "over_budget_projects": sum(
                1 for row in queries.budget_burn(conn, today) if row["over_budget"]
            ),
        }
    )


def register_routes(router: Router) -> None:
    """Add the insights routes: GET only, so viewer and above."""
    router.add("GET", "/insights/project-status", project_status)
    router.add("GET", "/insights/at-risk", at_risk)
    router.add("GET", "/insights/allocation", allocation)
    router.add("GET", "/insights/deliverables", deliverables)
    router.add("GET", "/insights/over-allocated", over_allocated)
    router.add("GET", "/insights/dependencies", dependencies)
    router.add("GET", "/insights/budget", budget)
    router.add("GET", "/insights/summary", summary)
