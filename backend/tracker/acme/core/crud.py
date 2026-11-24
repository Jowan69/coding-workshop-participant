"""Generic list, get, create, update and delete for one table, driven by a Resource."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from psycopg import sql

from acme.core.http import (
    BadRequest,
    Handler,
    NotFound,
    Request,
    Response,
    Router,
    created,
    no_content,
    ok,
)
from acme.core.validation import Check, Field, FieldError, check_references, clean, parse_param

if TYPE_CHECKING:
    import psycopg

DEFAULT_LIMIT = 50
MAX_LIMIT = 100

BeforeSave = Callable[[Request, dict[str, Any], dict[str, Any] | None], None]
AfterSave = Callable[[Request, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class Filter:
    """A query-string filter: ``param`` is parsed as ``kind`` and bound into ``where``.

    ``where`` is a fixed SQL fragment over the table alias ``t`` with ``%s`` placeholders,
    each bound to the parsed value; it defaults to ``t.<param> = %s``.
    """

    param: str
    kind: str  # int, string, bool, date, enum
    where: str | None = None
    choices: tuple[str, ...] = ()

    def condition(self) -> tuple[sql.Composable, int]:
        """Return the SQL condition and how many placeholders it has."""
        if self.where is None:
            return sql.SQL("{} = %s").format(sql.Identifier("t", self.param)), 1
        return sql.SQL(self.where), self.where.count("%s")


@dataclass(frozen=True)
class Resource:
    """Describes one table: what it returns, accepts, filters, searches and sorts by."""

    table: str
    label: str  # singular noun for messages, e.g. "project"
    columns: tuple[str, ...]  # columns returned to clients (never secrets)
    fields: tuple[Field, ...]  # columns clients may write
    filters: tuple[Filter, ...] = ()
    searchable: tuple[str, ...] = ()
    sortable: tuple[str, ...] = ()
    default_sort: str = "id"  # a sortable column, "-" prefix for descending
    extra_select: sql.Composable | None = None  # computed columns, e.g. "(...) AS total"
    checks: tuple[Check, ...] = ()  # record-level rules run on the merged row
    before_save: BeforeSave | None = None  # may adjust values; existing is None on create
    after_save: AfterSave | None = None  # may decorate the returned row
    role: str | None = None  # minimum role for every route; None uses the per-method default


def _select_list(res: Resource) -> sql.Composable:
    columns = sql.SQL(", ").join(sql.Identifier("t", column) for column in res.columns)
    if res.extra_select is None:
        return columns
    return sql.SQL("{}, {}").format(columns, res.extra_select)


def _int_param(query: dict[str, str], name: str, default: int, minimum: int) -> int:
    raw = query.get(name, "").strip()
    if not raw:
        return default
    # isascii(): str.isdigit() also accepts digits such as "²" that int() rejects
    if not (raw.isascii() and raw.isdigit()) or len(raw) > 18 or int(raw) < minimum:
        message = f"must be an integer of at least {minimum}"
        raise BadRequest(f"Invalid query parameter {name}", [{"field": name, "message": message}])
    return int(raw)


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _order_by(res: Resource, raw: str | None) -> sql.Composable:
    text = (raw or "").strip() or res.default_sort
    column = text.removeprefix("-")
    allowed = ("id", *res.sortable)
    if column not in allowed:
        message = "must be one of: " + ", ".join(allowed) + " (prefix - for descending)"
        raise BadRequest("Invalid query parameter sort", [{"field": "sort", "message": message}])
    direction = sql.SQL("DESC" if text.startswith("-") else "ASC")
    order = sql.SQL("{} {}").format(sql.Identifier("t", column), direction)
    if column == "id":
        return order
    return sql.SQL("{}, {}").format(order, sql.Identifier("t", "id"))


def list_rows(request: Request, res: Resource) -> dict[str, Any]:
    """List rows with filters, ``q`` search, ``sort``, ``limit`` (at most 100) and ``offset``.

    Returns:
        ``{"items": [...], "total": n, "limit": n, "offset": n}``.
    """
    query = request.query
    limit = min(_int_param(query, "limit", DEFAULT_LIMIT, 1), MAX_LIMIT)
    offset = _int_param(query, "offset", 0, 0)
    conditions: list[sql.Composable] = []
    params: list[Any] = []
    for spec in res.filters:
        if query.get(spec.param, "").strip():
            value = parse_param(spec.param, spec.kind, query[spec.param], spec.choices)
            condition, arity = spec.condition()
            conditions.append(condition)
            params.extend([value] * arity)
    search = query.get("q", "").strip()
    if search and res.searchable:
        matches = [sql.SQL("{} ILIKE %s").format(sql.Identifier("t", c)) for c in res.searchable]
        conditions.append(sql.SQL("({})").format(sql.SQL(" OR ").join(matches)))
        params.extend(["%" + _escape_like(search) + "%"] * len(res.searchable))
    where = sql.SQL(" WHERE ") + sql.SQL(" AND ").join(conditions) if conditions else sql.SQL("")
    table = sql.Identifier(res.table)
    count_query = sql.SQL("SELECT count(*) AS total FROM {} AS t{}").format(table, where)
    total = request.db.execute(count_query, params).fetchone()["total"]
    page_query = sql.SQL("SELECT {} FROM {} AS t{} ORDER BY {} LIMIT %s OFFSET %s").format(
        _select_list(res), table, where, _order_by(res, query.get("sort"))
    )
    items = request.db.execute(page_query, [*params, limit, offset]).fetchall()
    return {"items": items, "total": total, "limit": limit, "offset": offset}


def fetch(conn: psycopg.Connection, res: Resource, row_id: int) -> dict[str, Any]:
    """Return one row as clients see it.

    Raises:
        NotFound: If no row has that id.
    """
    query = sql.SQL("SELECT {} FROM {} AS t WHERE t.id = %s").format(
        _select_list(res), sql.Identifier(res.table)
    )
    row = conn.execute(query, (row_id,)).fetchone()
    if row is None:
        raise NotFound(f"{res.label.capitalize()} {row_id} not found")
    return row


def _fetch_for_update(conn: psycopg.Connection, res: Resource, row_id: int) -> dict[str, Any]:
    query = sql.SQL("SELECT * FROM {} WHERE id = %s FOR UPDATE").format(sql.Identifier(res.table))
    row = conn.execute(query, (row_id,)).fetchone()
    if row is None:
        raise NotFound(f"{res.label.capitalize()} {row_id} not found")
    return row


def _validated(
    request: Request, res: Resource, existing: dict[str, Any] | None
) -> dict[str, Any]:
    """Validate the body for a create (``existing`` None) or a partial update.

    Field errors, record-level checks on the merged row and missing references are
    reported together in one BadRequest.
    """
    values, errors = clean(request.body, res.fields, partial=existing is not None)
    if existing is not None:
        for spec in res.fields:
            if not spec.updatable and spec.name in values:
                if values.pop(spec.name) != existing[spec.name]:
                    errors.append({"field": spec.name, "message": "cannot be changed"})
        if not values and not errors:
            raise BadRequest("The request body has no fields that can be updated")
    merged = {**(existing or {}), **values}
    failed = {error["field"] for error in errors}
    for check in res.checks:
        errors.extend(error for error in check(merged) if error["field"] not in failed)
    errors.extend(check_references(request.db, values, res.fields))
    if errors:
        raise BadRequest("Validation failed", _dedupe(errors))
    return values


def _dedupe(errors: list[FieldError]) -> list[FieldError]:
    seen: set[tuple[str, str]] = set()
    unique = []
    for error in errors:
        key = (error["field"], error["message"])
        if key not in seen:
            seen.add(key)
            unique.append(error)
    return unique


def create_row(request: Request, res: Resource) -> dict[str, Any]:
    """Validate the body, insert a row and return it as clients see it."""
    values = _validated(request, res, None)
    if res.before_save:
        res.before_save(request, values, None)
    columns = list(values)
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING id").format(
        sql.Identifier(res.table),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join([sql.Placeholder()] * len(columns)),
    )
    row_id = request.db.execute(query, [values[column] for column in columns]).fetchone()["id"]
    row = fetch(request.db, res, row_id)
    return res.after_save(request, row) if res.after_save else row


def update_row(request: Request, res: Resource) -> dict[str, Any]:
    """Apply a partial update to ``request.params["id"]`` and return the updated row."""
    row_id = request.params["id"]
    existing = _fetch_for_update(request.db, res, row_id)
    values = _validated(request, res, existing)
    if res.before_save:
        res.before_save(request, values, existing)
    assignments = sql.SQL(", ").join(
        sql.SQL("{} = %s").format(sql.Identifier(column)) for column in values
    )
    query = sql.SQL("UPDATE {} SET {}, updated_at = now() WHERE id = %s").format(
        sql.Identifier(res.table), assignments
    )
    request.db.execute(query, [*values.values(), row_id])
    row = fetch(request.db, res, row_id)
    return res.after_save(request, row) if res.after_save else row


def delete_row(request: Request, res: Resource) -> None:
    """Delete ``request.params["id"]``.

    Raises:
        NotFound: If no row has that id.
    """
    row_id = request.params["id"]
    query = sql.SQL("DELETE FROM {} WHERE id = %s RETURNING id").format(sql.Identifier(res.table))
    if request.db.execute(query, (row_id,)).fetchone() is None:
        raise NotFound(f"{res.label.capitalize()} {row_id} not found")


def register(router: Router, base: str, res: Resource, **overrides: Handler) -> None:
    """Add the five CRUD routes for ``res`` under ``base``.

    Keyword overrides (``list``, ``create``, ``get``, ``update``, ``delete``) replace the
    generic handler for that route. Roles follow the per-method rule unless ``res.role``
    is set.
    """

    def delete(request: Request) -> Response:
        delete_row(request, res)
        return no_content()

    handlers: dict[str, Handler] = {
        "list": lambda request: ok(list_rows(request, res)),
        "create": lambda request: created(create_row(request, res)),
        "get": lambda request: ok(fetch(request.db, res, request.params["id"])),
        "update": lambda request: ok(update_row(request, res)),
        "delete": delete,
    }
    handlers.update(overrides)
    item = base + "/{id}"
    router.add("GET", base, handlers["list"], role=res.role)
    router.add("POST", base, handlers["create"], role=res.role)
    router.add("GET", item, handlers["get"], role=res.role)
    router.add("PUT", item, handlers["update"], role=res.role)
    router.add("DELETE", item, handlers["delete"], role=res.role)
