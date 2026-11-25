"""Departments are free text on projects and resources; keep one spelling per department."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import psycopg

# The earliest row that already uses the department, ignoring case. The row being saved is
# left out, so someone can still correct the case of a department only they use.
_IN_PROJECTS = (
    "SELECT department FROM projects WHERE lower(department) = lower(%s) "
    "AND id IS DISTINCT FROM %s ORDER BY id LIMIT 1"
)
_IN_RESOURCES = (
    "SELECT department FROM resources WHERE lower(department) = lower(%s) "
    "AND id IS DISTINCT FROM %s ORDER BY id LIMIT 1"
)


def existing_spelling(
    conn: psycopg.Connection, department: str, *, table: str, row_id: int | None = None
) -> str:
    """Return the spelling already stored for ``department``, or it unchanged if it is new.

    "engineering" becomes "Engineering" when a project or a person already has that. The
    table being written is asked first, then the other one.

    Args:
        conn: Database connection.
        department: The department as sent.
        table: ``projects`` or ``resources``: the table being written.
        row_id: The row being updated, which never counts as an existing spelling.
    """
    lookups = [(_IN_PROJECTS, "projects"), (_IN_RESOURCES, "resources")]
    lookups.sort(key=lambda lookup: lookup[1] != table)
    for query, source in lookups:
        exclude = row_id if source == table else None
        found = conn.execute(query, (department, exclude)).fetchone()
        if found:
            return found["department"]
    return department
