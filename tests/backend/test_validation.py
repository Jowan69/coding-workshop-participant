"""Field specs: types, rules, every error at once, record checks, references, query params."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from acme.core.http import BadRequest
from acme.core.validation import (
    boolean,
    check_references,
    clean,
    date_field,
    date_order,
    decimal,
    email,
    enum,
    integer,
    parse_param,
    reference,
    string,
    validate,
)

FIELDS = (
    string("name", required=True, max_length=5),
    email("email"),
    integer("count", minimum=1, maximum=10),
    decimal("amount", minimum=0, exclusive_minimum=True),
    date_field("day"),
    enum("colour", ("red", "blue")),
    boolean("active"),
)


def _errors(data: dict, fields=FIELDS, **kwargs) -> dict[str, str]:
    with pytest.raises(BadRequest) as caught:
        validate(data, fields, **kwargs)
    return {d["field"]: d["message"] for d in caught.value.details}


def test_valid_body_is_cleaned() -> None:
    values = validate(
        {
            "name": "  Ana ",
            "email": " Ana@Example.COM ",
            "count": 3,
            "amount": Decimal("9.99"),
            "day": "2026-03-01",
            "colour": "red",
            "active": False,
            "unknown": "ignored",
        },
        FIELDS,
    )
    assert values == {
        "name": "Ana",
        "email": "ana@example.com",
        "count": 3,
        "amount": Decimal("9.99"),
        "day": date(2026, 3, 1),
        "colour": "red",
        "active": False,
    }


def test_every_error_is_reported_at_once() -> None:
    errors = _errors(
        {
            "email": "nope",
            "count": 0,
            "amount": 0,
            "day": "01/03/2026",
            "colour": "green",
            "active": "yes",
        }
    )
    assert errors == {
        "name": "is required",
        "email": "must be a valid email address",
        "count": "must be at least 1",
        "amount": "must be greater than 0",
        "day": "must be a date in YYYY-MM-DD format",
        "colour": "must be one of: red, blue",
        "active": "must be true or false",
    }


@pytest.mark.parametrize(
    ("data", "field", "message"),
    [
        ({"name": "toolong"}, "name", "must be at most 5 characters"),
        ({"name": "   "}, "name", "is required"),
        ({"name": None}, "name", "is required"),
        ({"name": 5}, "name", "must be a string"),
        ({"name": "a", "count": True}, "count", "must be an integer"),
        ({"name": "a", "count": "3"}, "count", "must be an integer"),
        ({"name": "a", "count": Decimal("2.5")}, "count", "must be an integer"),
        ({"name": "a", "count": 11}, "count", "must be at most 10"),
        ({"name": "a", "amount": "5"}, "amount", "must be a number"),
        ({"name": "a", "amount": Decimal("1.005")}, "amount", "must have at most 2 decimal places"),
        ({"name": "a", "amount": Decimal("1e13")}, "amount", "must be at most 999999999999.99"),
        ({"name": "a", "day": "2026-02-30"}, "day", "must be a real calendar date"),
        ({"name": "a", "day": 20260101}, "day", "must be a date in YYYY-MM-DD format"),
        ({"name": "a", "active": None}, "active", "cannot be empty"),
        ({"name": "a", "colour": ""}, "colour", "cannot be empty"),
    ],
)
def test_single_rules(data: dict, field: str, message: str) -> None:
    assert _errors(data)[field] == message


def test_decimal_accepts_integers() -> None:
    assert validate({"name": "a", "amount": 7}, FIELDS)["amount"] == Decimal(7)


def test_optional_fields_can_be_cleared_with_null() -> None:
    assert validate({"name": "a", "email": None, "day": ""}, FIELDS) == {
        "name": "a",
        "email": None,
        "day": None,
    }


def test_partial_skips_missing_required_fields() -> None:
    assert validate({"count": 2}, FIELDS, partial=True) == {"count": 2}


def test_partial_still_rejects_clearing_required_fields() -> None:
    assert _errors({"name": ""}, partial=True) == {"name": "is required"}


def test_passwords_keep_surrounding_spaces() -> None:
    fields = (string("password", required=True, min_length=8, strip=False),)
    assert validate({"password": " spaced pw "}, fields)["password"] == " spaced pw "


@pytest.mark.parametrize("body", [None, [], "text", 3])
def test_body_must_be_an_object(body) -> None:
    with pytest.raises(BadRequest) as caught:
        clean(body, FIELDS)
    assert caught.value.message == "Request body must be a JSON object"


def test_date_order_check() -> None:
    check = date_order("start", "end")
    assert check({"start": date(2026, 1, 2), "end": date(2026, 1, 1)}) == [
        {"field": "end", "message": "must be on or after start"}
    ]
    assert check({"start": date(2026, 1, 1), "end": date(2026, 1, 1)}) == []
    assert check({"start": date(2026, 1, 1), "end": None}) == []


def test_check_references(conn) -> None:
    fields = (reference("owner_id", "users"), reference("project_id", "projects"))
    existing = conn.execute("SELECT id FROM users LIMIT 1").fetchone()["id"]
    assert check_references(conn, {"owner_id": existing, "project_id": None}, fields) == []
    assert check_references(conn, {"owner_id": 999999, "project_id": 888888}, fields) == [
        {"field": "owner_id", "message": "user 999999 does not exist"},
        {"field": "project_id", "message": "project 888888 does not exist"},
    ]


@pytest.mark.parametrize(
    ("kind", "raw", "expected"),
    [
        ("int", "42", 42),
        ("bool", "TRUE", True),
        ("bool", "false", False),
        ("date", "2026-05-06", date(2026, 5, 6)),
        ("string", " Ops ", "Ops"),
    ],
)
def test_parse_param_valid(kind: str, raw: str, expected) -> None:
    assert parse_param("p", kind, raw) == expected


@pytest.mark.parametrize(
    ("kind", "raw"),
    [("int", "-1"), ("int", "abc"), ("int", "1" * 19), ("bool", "yes"), ("date", "May 6"),
     ("enum", "purple"), ("string", "  ")],
)
def test_parse_param_invalid(kind: str, raw: str) -> None:
    with pytest.raises(BadRequest) as caught:
        parse_param("p", kind, raw, ("red",))
    assert caught.value.details[0]["field"] == "p"
