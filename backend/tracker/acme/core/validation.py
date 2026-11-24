"""Declarative field specs: validate a JSON body and report every field error at once."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from psycopg import sql

from acme.core.http import BadRequest

if TYPE_CHECKING:
    import psycopg

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONEY_MAX = Decimal("999999999999.99")  # numeric(14,2)

FieldError = dict[str, str]
Check = Callable[[Mapping[str, Any]], list[FieldError]]


@dataclass(frozen=True)
class Field:
    """One body field: its type and the rules it must satisfy."""

    name: str
    kind: str  # string, email, int, decimal, date, enum, bool
    required: bool = False
    nullable: bool = True  # optional fields only: may the client send null to clear it?
    updatable: bool = True  # False: may be set on create but never changed
    max_length: int | None = None
    min_length: int | None = None
    strip: bool = True  # False for passwords: surrounding spaces are significant
    choices: tuple[str, ...] = ()
    minimum: int | Decimal | None = None
    maximum: int | Decimal | None = None
    exclusive_minimum: bool = False
    references: str | None = None  # table whose id this integer must exist in


def string(
    name: str, *, required: bool = False, max_length: int = 255, min_length: int | None = None,
    strip: bool = True,
) -> Field:
    """A string, trimmed unless ``strip`` is False; empty or blank counts as missing."""
    return Field(
        name, "string", required=required, max_length=max_length, min_length=min_length,
        strip=strip,
    )


def email(name: str, *, required: bool = False) -> Field:
    """A trimmed, lower-cased email address."""
    return Field(name, "email", required=required, max_length=254)


def integer(
    name: str, *, required: bool = False, nullable: bool = True, minimum: int | None = None,
    maximum: int | None = None,
) -> Field:
    """A JSON integer (booleans are rejected), optionally within a range."""
    return Field(
        name, "int", required=required, nullable=nullable, minimum=minimum, maximum=maximum
    )


def decimal(
    name: str, *, required: bool = False, nullable: bool = True, minimum: int | None = None,
    exclusive_minimum: bool = False,
) -> Field:
    """A money amount: a JSON number with at most two decimal places."""
    return Field(
        name, "decimal", required=required, nullable=nullable, minimum=minimum,
        maximum=MONEY_MAX, exclusive_minimum=exclusive_minimum,
    )


def date_field(name: str, *, required: bool = False) -> Field:
    """A calendar date as ``YYYY-MM-DD``."""
    return Field(name, "date", required=required)


def enum(name: str, choices: tuple[str, ...], *, required: bool = False) -> Field:
    """One of a fixed set of strings; never null (the column has a default)."""
    return Field(name, "enum", required=required, nullable=False, choices=choices)


def boolean(name: str) -> Field:
    """``true`` or ``false``; never null (the column has a default)."""
    return Field(name, "bool", nullable=False)


def reference(name: str, table: str, *, required: bool = False, updatable: bool = True) -> Field:
    """The id of a row in ``table``; existence is checked by check_references()."""
    return Field(
        name, "int", required=required, updatable=updatable, minimum=1, references=table
    )


class _Invalid(ValueError):
    """A single field failed a rule; the message completes '<field> ...'."""


def _error(name: str, message: str) -> FieldError:
    return {"field": name, "message": message}


def _check_range(spec: Field, value: int | Decimal) -> None:
    if spec.minimum is not None:
        if spec.exclusive_minimum and value <= spec.minimum:
            raise _Invalid(f"must be greater than {spec.minimum}")
        if not spec.exclusive_minimum and value < spec.minimum:
            raise _Invalid(f"must be at least {spec.minimum}")
    if spec.maximum is not None and value > spec.maximum:
        raise _Invalid(f"must be at most {spec.maximum}")


def _coerce_text(spec: Field, value: Any) -> str:
    if not isinstance(value, str):
        raise _Invalid("must be a string")
    text = value.strip() if spec.strip else value
    if spec.kind == "email":
        text = text.lower()
        if not EMAIL_RE.match(text):
            raise _Invalid("must be a valid email address")
    if spec.min_length is not None and len(text) < spec.min_length:
        raise _Invalid(f"must be at least {spec.min_length} characters")
    if spec.max_length is not None and len(text) > spec.max_length:
        raise _Invalid(f"must be at most {spec.max_length} characters")
    return text


def _coerce_number(spec: Field, value: Any) -> int | Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise _Invalid("must be an integer" if spec.kind == "int" else "must be a number")
    if spec.kind == "int":
        if not isinstance(value, int):
            raise _Invalid("must be an integer")
        _check_range(spec, value)
        return value
    number = Decimal(value)
    exponent = number.as_tuple().exponent
    if not isinstance(exponent, int):
        raise _Invalid("must be a finite number")
    if exponent < -2:
        raise _Invalid("must have at most 2 decimal places")
    _check_range(spec, number)
    return number


def _coerce(spec: Field, value: Any) -> Any:
    if spec.kind in ("string", "email"):
        return _coerce_text(spec, value)
    if spec.kind in ("int", "decimal"):
        return _coerce_number(spec, value)
    if spec.kind == "date":
        if not isinstance(value, str) or not DATE_RE.match(value.strip()):
            raise _Invalid("must be a date in YYYY-MM-DD format")
        try:
            return date.fromisoformat(value.strip())
        except ValueError as exc:
            raise _Invalid("must be a real calendar date") from exc
    if spec.kind == "enum":
        if not isinstance(value, str) or value.strip() not in spec.choices:
            raise _Invalid("must be one of: " + ", ".join(spec.choices))
        return value.strip()
    if spec.kind == "bool":
        if not isinstance(value, bool):
            raise _Invalid("must be true or false")
        return value
    raise ValueError(f"unknown field kind {spec.kind!r}")


def clean(
    data: Any, fields: Iterable[Field], *, partial: bool = False
) -> tuple[dict[str, Any], list[FieldError]]:
    """Coerce ``data`` against ``fields`` and collect, rather than raise, field errors.

    Args:
        data: The parsed JSON body.
        fields: Specs to apply; keys not listed are ignored.
        partial: True for updates: absent fields are skipped, even required ones.

    Returns:
        ``(values, errors)``: cleaned values for the valid fields, and one error per bad field.

    Raises:
        BadRequest: If ``data`` is not a JSON object.
    """
    if not isinstance(data, dict):
        raise BadRequest("Request body must be a JSON object")
    values: dict[str, Any] = {}
    errors: list[FieldError] = []
    for spec in fields:
        if spec.name not in data:
            if spec.required and not partial:
                errors.append(_error(spec.name, "is required"))
            continue
        raw = data[spec.name]
        if isinstance(raw, str) and spec.kind != "bool" and not raw.strip():
            raw = None
        if raw is None:
            if spec.required:
                errors.append(_error(spec.name, "is required"))
            elif not spec.nullable:
                errors.append(_error(spec.name, "cannot be empty"))
            else:
                values[spec.name] = None
            continue
        try:
            values[spec.name] = _coerce(spec, raw)
        except _Invalid as exc:
            errors.append(_error(spec.name, str(exc)))
    return values, errors


def validate(data: Any, fields: Iterable[Field], *, partial: bool = False) -> dict[str, Any]:
    """Validate ``data`` and return cleaned values.

    Raises:
        BadRequest: Listing every field error at once.
    """
    values, errors = clean(data, fields, partial=partial)
    if errors:
        raise BadRequest("Validation failed", errors)
    return values


def date_order(start: str, end: str) -> Check:
    """A record-level check that ``end`` is on or after ``start`` when both are dates."""

    def check(record: Mapping[str, Any]) -> list[FieldError]:
        first, last = record.get(start), record.get(end)
        if isinstance(first, date) and isinstance(last, date) and last < first:
            return [_error(end, f"must be on or after {start}")]
        return []

    return check


def check_references(
    conn: psycopg.Connection, values: Mapping[str, Any], fields: Iterable[Field]
) -> list[FieldError]:
    """Return an error for each reference field whose id does not exist in its table."""
    errors: list[FieldError] = []
    for spec in fields:
        value = values.get(spec.name)
        if spec.references is None or value is None:
            continue
        query = sql.SQL("SELECT 1 FROM {} WHERE id = %s").format(sql.Identifier(spec.references))
        if conn.execute(query, (value,)).fetchone() is None:
            label = spec.references.removesuffix("s")
            errors.append(_error(spec.name, f"{label} {value} does not exist"))
    return errors


def parse_param(
    name: str, kind: str, raw: str, choices: tuple[str, ...] = ()
) -> int | bool | date | str:
    """Parse one query-string value.

    Raises:
        BadRequest: If ``raw`` is not a valid value of ``kind``.
    """
    text = raw.strip()
    try:
        if kind == "int":
            if not (text.isascii() and text.isdigit()) or len(text) > 18:
                raise _Invalid("must be a positive integer")
            return int(text)
        if kind == "bool":
            if text.lower() not in ("true", "false"):
                raise _Invalid("must be true or false")
            return text.lower() == "true"
        if kind in ("date", "enum"):
            return _coerce(Field(name, kind, choices=choices), text)
        if not text:
            raise _Invalid("cannot be empty")
        return text
    except _Invalid as exc:
        raise BadRequest(f"Invalid query parameter {name}", [_error(name, str(exc))]) from exc
