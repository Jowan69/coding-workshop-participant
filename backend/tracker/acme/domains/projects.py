"""Projects: CRUD plus delivery and budget figures on the single-project read."""

from __future__ import annotations

from decimal import Decimal

from acme.core.crud import Filter, Resource, fetch, register
from acme.core.http import Request, Response, Router, ok
from acme.core.validation import date_field, date_order, decimal, enum, reference, string
from acme.domains.deliverables import STATUSES as DELIVERABLE_STATUSES

STATUSES = ("planned", "active", "on_hold", "completed", "cancelled")

PROJECTS = Resource(
    table="projects",
    label="project",
    columns=(
        "id", "name", "department", "description", "status", "start_date", "end_date",
        "budget_planned", "owner_id", "created_at", "updated_at",
    ),
    fields=(
        string("name", required=True, max_length=150),
        string("department", required=True, max_length=100),
        string("description", max_length=2000),
        enum("status", STATUSES),
        date_field("start_date", required=True),
        date_field("end_date", required=True),
        decimal("budget_planned", nullable=False, minimum=0),
        reference("owner_id", "users"),
    ),
    filters=(
        Filter("status", "enum", choices=STATUSES),
        Filter("department", "string"),
        Filter("owner_id", "int"),
    ),
    searchable=("name", "description"),
    sortable=("name", "end_date", "status"),
    default_sort="name",
    checks=(date_order("start_date", "end_date"),),
)


def get_project(request: Request) -> Response:
    """One project plus deliverable counts by status, percent complete and budget spent."""
    project_id = request.params["id"]
    project = fetch(request.db, PROJECTS, project_id)
    rows = request.db.execute(
        "SELECT status, count(*) AS n FROM deliverables WHERE project_id = %s GROUP BY status",
        (project_id,),
    ).fetchall()
    counts = dict.fromkeys(DELIVERABLE_STATUSES, 0)
    counts.update({row["status"]: row["n"] for row in rows})
    total = sum(counts.values())
    spent = request.db.execute(
        "SELECT COALESCE(sum(amount), 0) AS spent FROM budget_entries WHERE project_id = %s",
        (project_id,),
    ).fetchone()["spent"]
    project["deliverable_counts"] = counts
    project["deliverables_total"] = total
    project["percent_complete"] = round(100 * counts["done"] / total, 1) if total else 0.0
    project["budget_spent"] = Decimal(spent)
    return ok(project)


def register_routes(router: Router) -> None:
    """Add the project routes."""
    register(router, "/projects", PROJECTS, get=get_project)
