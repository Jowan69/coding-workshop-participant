"""Deliverables: CRUD, completed_at stamping, and dependencies within one project."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from acme.core.crud import Filter, Resource, register
from acme.core.http import (
    BadRequest,
    Conflict,
    NotFound,
    Request,
    Response,
    Router,
    created,
    no_content,
    ok,
)
from acme.core.validation import date_field, enum, integer, reference, string, validate

STATUSES = ("not_started", "in_progress", "blocked", "done")


def _stamp_completion(
    request: Request, values: dict[str, Any], existing: dict[str, Any] | None
) -> None:
    """Moving to done stamps completed_at; leaving done clears it."""
    was_done = existing is not None and existing["status"] == "done"
    status = values.get("status", existing["status"] if existing else "not_started")
    if status == "done" and not was_done:
        values["completed_at"] = datetime.now(timezone.utc)
    elif status != "done" and was_done:
        values["completed_at"] = None


DELIVERABLES = Resource(
    table="deliverables",
    label="deliverable",
    columns=(
        "id", "project_id", "title", "description", "status", "due_date", "completed_at",
        "assignee_id", "created_at", "updated_at",
    ),
    fields=(
        reference("project_id", "projects", required=True, updatable=False),
        string("title", required=True, max_length=200),
        string("description", max_length=2000),
        enum("status", STATUSES),
        date_field("due_date", required=True),
        reference("assignee_id", "resources"),
    ),
    filters=(
        Filter("project_id", "int"),
        Filter("status", "enum", choices=STATUSES),
        Filter("assignee_id", "int"),
    ),
    searchable=("title",),
    sortable=("due_date", "title", "status"),
    default_sort="due_date",
    before_save=_stamp_completion,
)

DEPENDENCY_FIELDS = (integer("depends_on_id", required=True, minimum=1),)

_SUMMARY_QUERY = "SELECT id, project_id, title, status, due_date FROM deliverables WHERE id = %s"

# Does depends_on_id already (transitively) depend on deliverable_id? Then the new link
# would close a loop. UNION, not UNION ALL, so the walk ends even on bad data.
_CYCLE_QUERY = """
WITH RECURSIVE upstream (id) AS (
    SELECT depends_on_id FROM deliverable_dependencies WHERE deliverable_id = %(start)s
    UNION
    SELECT d.depends_on_id
    FROM deliverable_dependencies d
    JOIN upstream u ON d.deliverable_id = u.id
)
SELECT EXISTS (SELECT 1 FROM upstream WHERE id = %(target)s) AS cycle
"""


def _deliverable(request: Request, deliverable_id: int) -> dict[str, Any]:
    row = request.db.execute(_SUMMARY_QUERY, (deliverable_id,)).fetchone()
    if row is None:
        raise NotFound(f"Deliverable {deliverable_id} not found")
    return row


def _bad_dependency(message: str) -> BadRequest:
    return BadRequest(message, [{"field": "depends_on_id", "message": message}])


def list_dependencies(request: Request) -> Response:
    """The deliverables this one depends on."""
    deliverable_id = request.params["id"]
    _deliverable(request, deliverable_id)
    items = request.db.execute(
        "SELECT d.id, d.project_id, d.title, d.status, d.due_date "
        "FROM deliverable_dependencies dd JOIN deliverables d ON d.id = dd.depends_on_id "
        "WHERE dd.deliverable_id = %s ORDER BY d.due_date, d.id",
        (deliverable_id,),
    ).fetchall()
    return ok({"items": items, "total": len(items), "limit": len(items), "offset": 0})


def add_dependency(request: Request) -> Response:
    """Link this deliverable to one it depends on, refusing self, cross-project and cycles."""
    deliverable = _deliverable(request, request.params["id"])
    depends_on_id = validate(request.body, DEPENDENCY_FIELDS)["depends_on_id"]
    if depends_on_id == deliverable["id"]:
        raise _bad_dependency("A deliverable cannot depend on itself")
    target = request.db.execute(_SUMMARY_QUERY, (depends_on_id,)).fetchone()
    if target is None:
        raise _bad_dependency(f"deliverable {depends_on_id} does not exist")
    if target["project_id"] != deliverable["project_id"]:
        raise _bad_dependency(
            f"Deliverable {depends_on_id} belongs to another project; "
            "dependencies must stay within one project"
        )
    # Serialise dependency changes per project so two requests cannot form a cycle together
    request.db.execute(
        "SELECT id FROM projects WHERE id = %s FOR UPDATE", (deliverable["project_id"],)
    )
    exists = request.db.execute(
        "SELECT 1 FROM deliverable_dependencies WHERE deliverable_id = %s AND depends_on_id = %s",
        (deliverable["id"], depends_on_id),
    ).fetchone()
    if exists:
        raise Conflict(
            f"Deliverable {deliverable['id']} already depends on {depends_on_id}",
            [{"field": "depends_on_id", "message": "already a dependency"}],
            code="duplicate",
        )
    cycle = request.db.execute(
        _CYCLE_QUERY, {"start": depends_on_id, "target": deliverable["id"]}
    ).fetchone()["cycle"]
    if cycle:
        raise _bad_dependency(
            f"Deliverable {depends_on_id} already depends on {deliverable['id']} "
            "(directly or through others), so this link would create a cycle"
        )
    request.db.execute(
        "INSERT INTO deliverable_dependencies (deliverable_id, depends_on_id) VALUES (%s, %s)",
        (deliverable["id"], depends_on_id),
    )
    return created({"deliverable_id": deliverable["id"], "depends_on": target})


def remove_dependency(request: Request) -> Response:
    """Remove one dependency link."""
    deliverable_id = request.params["id"]
    depends_on_id = request.params["depends_on_id"]
    removed = request.db.execute(
        "DELETE FROM deliverable_dependencies WHERE deliverable_id = %s AND depends_on_id = %s "
        "RETURNING deliverable_id",
        (deliverable_id, depends_on_id),
    ).fetchone()
    if removed is None:
        raise NotFound(f"Deliverable {deliverable_id} does not depend on {depends_on_id}")
    return no_content()


def register_routes(router: Router) -> None:
    """Add the deliverable and dependency routes."""
    register(router, "/deliverables", DELIVERABLES)
    router.add("GET", "/deliverables/{id}/dependencies", list_dependencies)
    router.add("POST", "/deliverables/{id}/dependencies", add_dependency)
    router.add("DELETE", "/deliverables/{id}/dependencies/{depends_on_id}", remove_dependency)
