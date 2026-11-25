"""Budget entries: spending per project, and a planned-versus-spent summary."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from acme.core.crud import Filter, Resource, register
from acme.core.http import BadRequest, NotFound, Request, Response, Router, ok
from acme.core.validation import date_field, decimal, enum, parse_param, reference, string

CATEGORIES = ("labor", "software", "hardware", "services", "other")


def _set_creator(
    request: Request, values: dict[str, Any], existing: dict[str, Any] | None
) -> None:
    """created_by always comes from the token, never from the body."""
    if existing is None:
        values["created_by"] = request.user["id"]


BUDGETS = Resource(
    table="budget_entries",
    label="budget entry",
    columns=(
        "id", "project_id", "category", "description", "amount", "spent_on", "created_by",
        "created_at", "updated_at",
    ),
    fields=(
        reference("project_id", "projects", required=True),
        enum("category", CATEGORIES, required=True),
        string("description", max_length=500, multiline=True),
        decimal("amount", required=True, minimum=0, exclusive_minimum=True),
        date_field("spent_on", required=True),
    ),
    filters=(
        Filter("project_id", "int"),
        Filter("category", "enum", choices=CATEGORIES),
        Filter("spent_from", "date", where="t.spent_on >= %s"),
        Filter("spent_to", "date", where="t.spent_on <= %s"),
    ),
    searchable=("description",),
    sortable=("spent_on", "amount", "category"),
    default_sort="-spent_on",
    before_save=_set_creator,
)


def summary(request: Request) -> Response:
    """Planned, spent, remaining and percent used for ``?project_id=``."""
    raw = request.query.get("project_id", "")
    if not raw.strip():
        raise BadRequest(
            "project_id is required", [{"field": "project_id", "message": "is required"}]
        )
    project_id = parse_param("project_id", "int", raw)
    project = request.db.execute(
        "SELECT id, name, budget_planned FROM projects WHERE id = %s", (project_id,)
    ).fetchone()
    if project is None:
        raise NotFound(f"Project {project_id} not found")
    spent = Decimal(
        request.db.execute(
            "SELECT COALESCE(sum(amount), 0) AS spent FROM budget_entries WHERE project_id = %s",
            (project_id,),
        ).fetchone()["spent"]
    )
    planned = project["budget_planned"]
    percent = round(float(spent / planned * 100), 1) if planned > 0 else None
    return ok(
        {
            "project_id": project_id,
            "project_name": project["name"],
            "planned": planned,
            "spent": spent,
            "remaining": planned - spent,
            "percent_used": percent,
        }
    )


def register_routes(router: Router) -> None:
    """Add the budget routes; /budgets/summary never clashes with /budgets/{id} (digits only)."""
    router.add("GET", "/budgets/summary", summary)
    register(router, "/budgets", BUDGETS)
