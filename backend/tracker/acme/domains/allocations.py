"""Allocations: who works on which project, how much and when, with over-allocation warnings."""

from __future__ import annotations

from typing import Any

from acme.core.crud import Filter, Resource, register
from acme.core.http import Request, Router
from acme.core.validation import date_field, date_order, integer, reference, string

# The total is a step function that only rises where an allocation starts, so its peak over
# [start, end] is at the range start or at the start of an overlapping allocation.
_PEAK_QUERY = """
SELECT COALESCE(max(daily.total), 0) AS peak
FROM (
    SELECT sum(a.allocation_pct) AS total
    FROM (
        SELECT DISTINCT GREATEST(o.start_date, %(start)s::date) AS day
        FROM allocations o
        WHERE o.resource_id = %(resource)s
          AND o.start_date <= %(end)s AND o.end_date >= %(start)s
    ) days
    JOIN allocations a
      ON a.resource_id = %(resource)s AND a.start_date <= days.day AND a.end_date >= days.day
    GROUP BY days.day
) daily
"""


def _flag_over_allocation(request: Request, row: dict[str, Any]) -> dict[str, Any]:
    """Add a warning when the person's peak total in this period exceeds their capacity."""
    params = {"resource": row["resource_id"], "start": row["start_date"], "end": row["end_date"]}
    peak = request.db.execute(_PEAK_QUERY, params).fetchone()["peak"]
    capacity = request.db.execute(
        "SELECT capacity_pct FROM resources WHERE id = %s", (row["resource_id"],)
    ).fetchone()["capacity_pct"]
    if peak > capacity:
        row["warning"] = "over_allocated"
        row["total_allocation_pct"] = int(peak)
        row["capacity_pct"] = capacity
    return row


ALLOCATIONS = Resource(
    table="allocations",
    label="allocation",
    columns=(
        "id", "resource_id", "project_id", "allocation_pct", "start_date", "end_date",
        "role_on_project", "created_at", "updated_at",
    ),
    fields=(
        reference("resource_id", "resources", required=True),
        reference("project_id", "projects", required=True),
        integer("allocation_pct", required=True, minimum=1, maximum=100),
        date_field("start_date", required=True),
        date_field("end_date", required=True),
        string("role_on_project", max_length=100),
    ),
    filters=(
        Filter("resource_id", "int"),
        Filter("project_id", "int"),
        Filter("active_on", "date", where="t.start_date <= %s AND t.end_date >= %s"),
    ),
    sortable=("start_date", "end_date", "allocation_pct"),
    default_sort="start_date",
    checks=(date_order("start_date", "end_date"),),
    after_save=_flag_over_allocation,
)


def register_routes(router: Router) -> None:
    """Add the allocation routes."""
    register(router, "/allocations", ALLOCATIONS)
