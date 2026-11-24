"""Resources (people): CRUD, with each person's total allocation for today."""

from __future__ import annotations

from psycopg import sql

from acme.core.crud import Filter, Resource, register
from acme.core.http import Router
from acme.core.validation import boolean, email, integer, string

RESOURCES = Resource(
    table="resources",
    label="resource",
    columns=(
        "id", "full_name", "email", "job_title", "department", "capacity_pct", "is_active",
        "created_at", "updated_at",
    ),
    fields=(
        string("full_name", required=True, max_length=120),
        email("email", required=True),
        string("job_title", max_length=120),
        string("department", max_length=100),
        integer("capacity_pct", nullable=False, minimum=1, maximum=100),
        boolean("is_active"),
    ),
    filters=(Filter("department", "string"), Filter("is_active", "bool")),
    searchable=("full_name", "email", "job_title"),
    sortable=("full_name", "department", "capacity_pct"),
    default_sort="full_name",
    extra_select=sql.SQL(
        "(SELECT COALESCE(sum(a.allocation_pct), 0) FROM allocations a "
        "WHERE a.resource_id = t.id AND CURRENT_DATE BETWEEN a.start_date AND a.end_date) "
        "AS allocation_today_pct"
    ),
)


def register_routes(router: Router) -> None:
    """Add the resource routes."""
    register(router, "/resources", RESOURCES)
