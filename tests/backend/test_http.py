"""Event parsing, prefix stripping, routing, JSON encoding and the dispatch pipeline."""

from __future__ import annotations

import dataclasses
import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from psycopg import errors as pg_errors

from acme.core.http import (
    BadRequest,
    Response,
    Router,
    _from_database_error,
    ok,
    parse_event,
    strip_prefix,
    to_lambda,
)
from conftest import make_event


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("/api/tracker/projects/5", "/projects/5"),
        ("/projects/5", "/projects/5"),
        ("/api/tracker", "/"),
        ("/api/tracker/", "/"),
        ("/api/trackers/projects", "/api/trackers/projects"),
        ("/", "/"),
    ],
)
def test_strip_prefix_accepts_both_path_styles(raw: str, expected: str) -> None:
    assert strip_prefix(raw) == expected


def _router() -> Router:
    router = Router()
    router.add("GET", "/projects", lambda r: ok("list"))
    router.add("GET", "/projects/{id}", lambda r: ok("one"))
    router.add("DELETE", "/deliverables/{id}/dependencies/{depends_on_id}", lambda r: ok("rm"))
    router.add("GET", "/budgets/summary", lambda r: ok("summary"))
    router.add("GET", "/budgets/{id}", lambda r: ok("budget"))
    router.add("POST", "/auth/login", lambda r: ok("login"), public=True)
    router.add("GET", "/auth/users", lambda r: ok("users"), role="admin")
    return router


def test_router_captures_integer_params() -> None:
    route, params = _router().match("DELETE", "/deliverables/12/dependencies/7")
    assert params == {"id": 12, "depends_on_id": 7}
    assert route.min_role == "manager"


def test_router_accepts_a_trailing_slash() -> None:
    assert _router().match("GET", "/projects/")[0].template == "/projects"


@pytest.mark.parametrize("path", ["/projects/abc", "/projects/-1", "/projects/1/x", "/nope"])
def test_router_rejects_non_matching_paths(path: str) -> None:
    assert _router().match("GET", path) is None


def test_router_matches_method_too() -> None:
    assert _router().match("POST", "/projects/1") is None


def test_router_keeps_summary_apart_from_ids() -> None:
    router = _router()
    assert router.match("GET", "/budgets/summary")[0].template == "/budgets/summary"
    assert router.match("GET", "/budgets/3")[0].template == "/budgets/{id}"


def test_router_role_defaults_and_overrides() -> None:
    router = _router()
    assert router.match("GET", "/projects")[0].min_role == "viewer"
    assert router.match("POST", "/auth/login")[0].min_role is None
    assert router.match("GET", "/auth/users")[0].min_role == "admin"


def test_parse_event_reads_method_path_headers_query_and_body() -> None:
    event = make_event(
        "post",
        "/api/tracker/projects",
        body={"budget": 10.25, "name": "X"},
        query={"status": "active"},
        headers={"X-Custom": "Yes"},
    )
    request = parse_event(event)
    assert request.method == "POST"
    assert request.path == "/projects"
    assert request.query == {"status": "active"}
    assert request.headers["x-custom"] == "Yes"
    assert request.body == {"budget": Decimal("10.25"), "name": "X"}


def test_parse_event_first_query_value_wins() -> None:
    event = make_event("GET", "/projects")
    event["rawQueryString"] = "status=active&status=planned&q="
    assert parse_event(event).query == {"status": "active", "q": ""}


def test_parse_event_falls_back_to_query_string_parameters() -> None:
    event = make_event("GET", "/projects")
    event["rawQueryString"] = ""
    event["queryStringParameters"] = {"limit": "5"}
    assert parse_event(event).query == {"limit": "5"}


def test_parse_event_decodes_base64_bodies() -> None:
    event = make_event("POST", "/projects", body={"name": "Encoded"}, base64_body=True)
    assert parse_event(event).body == {"name": "Encoded"}


def test_parse_event_treats_blank_body_as_none() -> None:
    assert parse_event(make_event("POST", "/projects", raw_body="   ")).body is None


@pytest.mark.parametrize(
    ("raw", "code"),
    [("{not json", "malformed_json"), ('{"a": NaN}', "malformed_json")],
)
def test_parse_event_rejects_malformed_json(raw: str, code: str) -> None:
    with pytest.raises(BadRequest) as caught:
        parse_event(make_event("POST", "/projects", raw_body=raw))
    assert caught.value.code == code


def test_parse_event_rejects_bad_base64() -> None:
    event = make_event("POST", "/projects", raw_body="!!!not base64!!!")
    event["isBase64Encoded"] = True
    with pytest.raises(BadRequest) as caught:
        parse_event(event)
    assert caught.value.code == "malformed_body"


def test_to_lambda_encodes_decimals_and_dates() -> None:
    body = {
        "amount": Decimal("12.50"),
        "day": date(2026, 1, 2),
        "at": datetime(2026, 1, 2, 3, 4, tzinfo=timezone.utc),
    }
    encoded = to_lambda(ok(body))
    assert encoded["statusCode"] == 200
    assert encoded["headers"]["Content-Type"] == "application/json"
    assert json.loads(encoded["body"]) == {
        "amount": 12.5,
        "day": "2026-01-02",
        "at": "2026-01-02T03:04:00+00:00",
    }


def test_to_lambda_204_has_empty_body() -> None:
    assert to_lambda(Response(204))["body"] == ""


def test_to_lambda_refuses_unknown_types() -> None:
    with pytest.raises(TypeError):
        to_lambda(ok({"x": object()}))


def test_dispatch_returns_error_envelope_for_malformed_json(api) -> None:
    result = api.call("POST", "/projects", raw_body="{oops")
    assert result.status == 400
    assert result.error["code"] == "malformed_json"
    assert result.error["details"] == []


def test_dispatch_unknown_route_needs_a_token_first(api) -> None:
    assert api.get("/nothing-here", role=None).status == 401
    result = api.get("/nothing-here", role="viewer")
    assert result.status == 404
    assert result.error["code"] == "route_not_found"


def test_dispatch_logs_one_line_without_secrets(api, tokens, caplog) -> None:
    caplog.set_level(logging.INFO, logger="acme.http")
    api.get("/projects", role="viewer")
    lines = [r.getMessage() for r in caplog.records if r.name == "acme.http"]
    assert len(lines) == 1
    assert "method=GET" in lines[0]
    assert "path=" + api.prefix + "/projects" in lines[0]
    assert "status=200" in lines[0]
    assert "user_id=" in lines[0] and "user_id=-" not in lines[0]
    assert tokens["viewer"] not in lines[0]


def test_dispatch_hides_unexpected_errors(api, monkeypatch, caplog) -> None:
    import function

    def explode(request):
        raise RuntimeError("secret internals")

    route, _ = function.ROUTER.match("GET", "/projects")
    patched = [dataclasses.replace(r, handler=explode) if r is route else r
               for r in function.ROUTER.routes]
    monkeypatch.setattr(function.ROUTER, "routes", patched)
    caplog.set_level(logging.ERROR, logger="acme.http")
    result = api.get("/projects")
    assert result.status == 500
    assert result.error == {
        "code": "internal_error",
        "message": "Internal server error",
        "details": [],
    }
    assert "secret internals" not in json.dumps(result.body)
    assert any("unhandled error" in r.getMessage() for r in caplog.records)


class _Diag:
    def __init__(self, table: str, constraint: str) -> None:
        self.table_name = table
        self.constraint_name = constraint


class _FakeUnique(pg_errors.UniqueViolation):
    def __init__(self, table: str, constraint: str) -> None:
        super().__init__("duplicate")
        self._fake_diag = _Diag(table, constraint)

    @property
    def diag(self):  # type: ignore[override]
        return self._fake_diag


def test_unique_violation_names_the_column() -> None:
    response = _from_database_error(_FakeUnique("projects", "projects_name_key"), "POST")
    assert response.status == 409
    assert response.body["error"]["details"] == [{"field": "name", "message": "already exists"}]


def test_unique_violation_without_column() -> None:
    response = _from_database_error(_FakeUnique("t", "t_pkey"), "POST")
    assert response.status == 409
    assert response.body["error"]["details"] == []


def test_foreign_key_violation_depends_on_method() -> None:
    assert _from_database_error(pg_errors.ForeignKeyViolation("x"), "DELETE").status == 409
    assert _from_database_error(pg_errors.ForeignKeyViolation("x"), "POST").status == 400


def test_data_errors_become_400_and_others_pass_through() -> None:
    assert _from_database_error(pg_errors.CheckViolation("x"), "PUT").status == 400
    assert _from_database_error(pg_errors.NumericValueOutOfRange("x"), "PUT").status == 400
    assert _from_database_error(RuntimeError("x"), "GET") is None


def test_base64_bodies_work_end_to_end(api) -> None:
    body = {"email": "admin@acme.test", "password": "wrong-password"}
    result = api.call("POST", "/auth/login", role=None, body=body, base64_body=True)
    assert result.status == 401


def test_raw_function_url_shape(api) -> None:
    import function

    event = make_event("GET", api.prefix + "/health")
    response = function.handler(event, None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"status": "ok", "database": "ok"}
