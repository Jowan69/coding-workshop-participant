"""Projects: CRUD with progress and spend on every read, plus status counts on the detail."""

from __future__ import annotations

from psycopg import sql

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
    # Lists show progress and spend per row, so they are computed in SQL for every read.
    # owner_name too: only admins can read /auth/users, but everyone sees who owns a project.
    extra_select=sql.SQL(
        "(SELECT COALESCE(round(100.0 * count(*) FILTER (WHERE d.status = 'done') "
        "/ NULLIF(count(*), 0), 1), 0) FROM deliverables d WHERE d.project_id = t.id) "
        "AS percent_complete, "
        "(SELECT COALESCE(sum(b.amount), 0) FROM budget_entries b WHERE b.project_id = t.id) "
        "AS budget_spent, "
        "(SELECT u.full_name FROM users u WHERE u.id = t.owner_id) AS owner_name"
    ),
)


def get_project(request: Request) -> Response:
    """One project plus its deliverable counts by status (progress and spend come with it)."""
    project_id = request.params["id"]
    project = fetch(request.db, PROJECTS, project_id)
    rows = request.db.execute(
        "SELECT status, count(*) AS n FROM deliverables WHERE project_id = %s GROUP BY status",
        (project_id,),
    ).fetchall()
    counts = dict.fromkeys(DELIVERABLE_STATUSES, 0)
    counts.update({row["status"]: row["n"] for row in rows})
    project["deliverable_counts"] = counts
    project["deliverables_total"] = sum(counts.values())
    return ok(project)


def register_routes(router: Router) -> None:
    """Add the project routes."""
    register(router, "/projects", PROJECTS, get=get_project)
