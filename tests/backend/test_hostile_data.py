"""Phase 6, part E: hostile and awkward data."""

from __future__ import annotations

import base64
import dataclasses
import json
import time
from datetime import date, timedelta

import psycopg
import pytest
from psycopg import errors as pg_errors

from acme.core import db
from acme.core.http import MAX_BODY_BYTES, _from_database_error
from acme.core.validation import has_control_characters
from acme.domains import dependency_chain
from acme.domains.dependency_chain import build_chain
from conftest import id_of, make_event


@pytest.fixture
def today(conn) -> date:
    return conn.execute("SELECT CURRENT_DATE AS today").fetchone()["today"]


def _project(conn, name: str, *, status: str = "active", end: int = 30) -> int:
    return conn.execute(
        "INSERT INTO projects (name, department, status, start_date, end_date) "
        "VALUES (%s, 'Test', %s, CURRENT_DATE - 30, CURRENT_DATE + %s) RETURNING id",
        (name, status, end),
    ).fetchone()["id"]


def _deliverable(conn, project_id: int, title: str, *, status: str = "not_started",
                 due: int = 10) -> int:
    completed = "now()" if status == "done" else "NULL"
    return conn.execute(
        "INSERT INTO deliverables (project_id, title, status, due_date, completed_at) "
        f"VALUES (%s, %s, %s, CURRENT_DATE + %s, {completed}) RETURNING id",
        (project_id, title, status, due),
    ).fetchone()["id"]


# E2: the dependency insight


def _item(node: int, status: str = "not_started", due: str = "2026-06-01") -> dict:
    return {"id": node, "title": f"D{node}", "status": status, "due_date": due}


def _by_id(rows: list[dict]) -> dict[int, dict]:
    return {row["id"]: row for row in rows}


def test_forty_deliverables_each_depending_on_all_earlier_ones_answer_within_a_second(
    api, conn
) -> None:
    project = _project(conn, "Dense dependencies")
    ids = [_deliverable(conn, project, f"Step {n:02d}", due=n) for n in range(40)]
    links = [(later, earlier) for index, later in enumerate(ids) for earlier in ids[:index]]
    assert len(links) == 780
    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO deliverable_dependencies (deliverable_id, depends_on_id) VALUES (%s, %s)",
            links,
        )

    started = time.perf_counter()
    result = api.get("/insights/dependencies", query={"project_id": project}, role="viewer")
    elapsed = time.perf_counter() - started

    assert result.status == 200
    assert elapsed < 1.0, f"took {elapsed:.2f}s"
    items = _by_id(result.body["items"])
    assert [items[node]["depth"] for node in ids] == list(range(40))
    assert items[ids[-1]]["upstream_ids"] == sorted(ids[:-1])
    assert items[ids[-1]]["depends_on_ids"] == sorted(ids[:-1])
    assert result.body["longest_chain"] == ids
    assert [item["id"] for item in result.body["items"]] == ids


def test_the_response_shape_is_unchanged(api, conn) -> None:
    banking = id_of(conn, "projects", "name", "Mobile Banking App")
    body = api.get("/insights/dependencies", query={"project_id": banking}).body
    assert list(body) == ["project_id", "project_name", "items", "longest_chain"]
    assert list(body["items"][0]) == [
        "id", "title", "status", "due_date", "depth", "upstream_ids", "blocked_by_upstream",
        "depends_on_ids",
    ]


def test_the_dependency_insight_makes_two_queries_for_the_chain(conn, monkeypatch) -> None:
    from acme.domains import insights_sql

    banking = id_of(conn, "projects", "name", "Mobile Banking App")

    class Counting:
        def __init__(self) -> None:
            self.queries: list[str] = []

        def execute(self, query, params=None):
            self.queries.append(query)
            return conn.execute(query, params)

    counting = Counting()
    rows = insights_sql.dependency_chain(counting, banking)
    assert len(rows) == 5
    assert len(counting.queries) == 2
    assert not any("RECURSIVE" in query.upper() for query in counting.queries)


def test_build_chain_on_a_diamond_prefers_the_lower_ids_between_equal_chains() -> None:
    rows = _by_id(build_chain(
        [_item(1, "done"), _item(2, "blocked"), _item(3), _item(4)],
        [(2, 1), (3, 1), (4, 2), (4, 3)],
    ))
    assert rows[4]["depth"] == 2
    assert rows[4]["chain_to_root"] == [4, 2, 1]
    assert rows[4]["upstream_ids"] == [1, 2, 3]
    assert rows[4]["depends_on_ids"] == [2, 3]
    assert rows[4]["blocked_by_upstream"] is True
    assert rows[3]["blocked_by_upstream"] is False
    assert rows[2]["blocked_by_upstream"] is False  # blocked itself, nothing upstream is


def test_build_chain_orders_by_depth_then_due_date_then_id() -> None:
    rows = build_chain(
        [_item(1, due="2026-03-01"), _item(2, due="2026-01-01"), _item(3, due="2026-01-01"),
         _item(4, due="2026-02-01")],
        [(4, 1)],
    )
    assert [row["id"] for row in rows] == [2, 3, 1, 4]


def test_build_chain_ignores_links_that_leave_the_project_and_duplicates() -> None:
    rows = _by_id(build_chain([_item(1), _item(2)], [(2, 1), (2, 1), (2, 99), (98, 1), (1, 1)]))
    assert rows[2]["depends_on_ids"] == [1]
    assert rows[2]["upstream_ids"] == [1]
    assert rows[1]["depth"] == 0


def test_build_chain_ends_on_a_cycle_with_the_same_answers_as_before() -> None:
    # 1 -> 3 -> 2 -> 1 is a cycle; 4 hangs below it; 5 is a clean root that 2 also needs
    rows = _by_id(build_chain(
        [_item(1), _item(2), _item(3), _item(4), _item(5, "blocked")],
        [(2, 1), (3, 2), (1, 3), (4, 3), (2, 5)],
    ))
    assert rows[1]["chain_to_root"] == [1, 3, 2, 5]
    assert rows[2]["chain_to_root"] == [2, 1, 3]
    assert rows[3]["chain_to_root"] == [3, 2, 1]
    assert rows[4]["chain_to_root"] == [4, 3, 2, 1]
    assert rows[1]["upstream_ids"] == [2, 3, 5]
    assert rows[4]["upstream_ids"] == [1, 2, 3, 5]
    assert rows[5]["depth"] == 0 and rows[5]["upstream_ids"] == []
    assert all(rows[node]["blocked_by_upstream"] for node in (1, 2, 3, 4))


def test_build_chain_stops_a_runaway_cycle_search_at_its_budget(monkeypatch) -> None:
    # 24 deliverables that all depend on each other: 24! simple paths, far beyond any budget
    nodes = list(range(1, 25))
    edges = [(a, b) for a in nodes for b in nodes if a != b]
    monkeypatch.setattr(dependency_chain, "CYCLE_WORK_BUDGET", 5_000)
    started = time.perf_counter()
    rows = _by_id(build_chain([_item(node) for node in nodes], edges))
    assert time.perf_counter() - started < 2.0
    assert set(rows) == set(nodes)
    for node in nodes:
        chain = rows[node]["chain_to_root"]
        assert chain[0] == node and len(set(chain)) == len(chain)  # a real, simple chain
        assert rows[node]["upstream_ids"] == [other for other in nodes if other != node]


def test_build_chain_handles_a_chain_longer_than_the_recursion_limit() -> None:
    count = 5_000
    rows = build_chain(
        [_item(node) for node in range(1, count + 1)],
        [(node, node - 1) for node in range(2, count + 1)],
    )
    assert rows[-1]["depth"] == count - 1
    assert rows[-1]["chain_to_root"][:3] == [count, count - 1, count - 2]


def test_build_chain_of_nothing() -> None:
    assert build_chain([], []) == []


# E2: statement timeout


def test_connections_set_a_15_second_statement_timeout_and_utc(conn, monkeypatch, database) -> None:
    captured = {}
    monkeypatch.setattr(psycopg, "connect", lambda **kwargs: captured.update(kwargs))
    db.connect(database.SETTINGS)
    assert "-c statement_timeout=15000" in captured["options"]
    assert "-c timezone=UTC" in captured["options"]
    assert conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"] == "15s"
    assert conn.execute("SHOW timezone").fetchone()["TimeZone"] == "UTC"


def _replace_handler(monkeypatch, method: str, template: str, handler) -> None:
    import function

    patched = [
        dataclasses.replace(route, handler=handler)
        if (route.method, route.template) == (method, template) else route
        for route in function.ROUTER.routes
    ]
    monkeypatch.setattr(function.ROUTER, "routes", patched)


def test_a_cancelled_query_is_a_503_and_is_not_retried(api, conn, monkeypatch) -> None:
    calls = []

    def slow(request):
        calls.append(1)
        request.db.execute("SET LOCAL statement_timeout = 50")
        request.db.execute("SELECT pg_sleep(2)")
        raise AssertionError("the query should have been cancelled")

    _replace_handler(monkeypatch, "GET", "/projects", slow)
    started = time.perf_counter()
    result = api.get("/projects", role="viewer")
    assert time.perf_counter() - started < 1.5
    assert result.status == 503
    assert result.error == {
        "code": "query_timeout",
        "message": "The database took too long to answer. Try again.",
        "details": [],
    }
    assert result.headers["Retry-After"] == "5"
    assert calls == [1]
    # the connection is still good for the next request
    assert api.get("/resources", role="viewer").status == 200
    assert conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"] == "15s"


def test_query_cancelled_maps_to_503_for_every_method() -> None:
    for method in ("GET", "POST", "PUT", "DELETE"):
        response = _from_database_error(pg_errors.QueryCanceled("canceling statement"), method)
        assert response.status == 503
        assert response.body["error"]["code"] == "query_timeout"


# E3: body size and depth


def test_json_nested_too_deep_is_a_400(api) -> None:
    deep = "[" * 100_000 + "]" * 100_000
    assert len(deep) < MAX_BODY_BYTES
    result = api.call("POST", "/projects", raw_body=deep)
    assert result.status == 400
    assert result.error["code"] == "malformed_json"
    assert "nested too deeply" in result.error["message"]
    deep_object = '{"a":' * 20_000 + "1" + "}" * 20_000
    assert len(deep_object) < MAX_BODY_BYTES
    nested = api.call("POST", "/projects", raw_body=deep_object)
    assert (nested.status, nested.error["code"]) == (400, "malformed_json")


def test_a_body_over_256_kb_is_a_413(api) -> None:
    assert MAX_BODY_BYTES == 256 * 1024
    padding = "x" * (MAX_BODY_BYTES - len('{"name": ""}') + 1)
    too_big = json.dumps({"name": padding})
    assert len(too_big) == MAX_BODY_BYTES + 1
    result = api.call("POST", "/projects", raw_body=too_big)
    assert result.status == 413
    assert result.error["code"] == "payload_too_large"
    assert result.error["message"] == "Request body is larger than 256 KB"
    assert result.error["details"] == []


def test_a_body_of_exactly_256_kb_is_read(api) -> None:
    padding = "x" * (MAX_BODY_BYTES - len('{"name": ""}'))
    at_limit = json.dumps({"name": padding})
    assert len(at_limit) == MAX_BODY_BYTES
    result = api.call("POST", "/projects", raw_body=at_limit)
    assert result.status == 400  # read and validated: the name is far too long
    assert "name" in result.fields


def test_the_limit_counts_bytes_and_covers_base64_bodies(api) -> None:
    multibyte = json.dumps({"name": "é" * (MAX_BODY_BYTES // 2)}, ensure_ascii=False)
    assert len(multibyte) < MAX_BODY_BYTES < len(multibyte.encode("utf-8"))
    assert api.call("POST", "/projects", raw_body=multibyte).status == 413
    encoded = base64.b64encode(b"x" * (MAX_BODY_BYTES + 100)).decode("ascii")
    event = make_event("POST", api.prefix + "/projects", raw_body=encoded)
    event["isBase64Encoded"] = True
    import function

    response = function.handler(event)
    assert response["statusCode"] == 413


def test_oversized_bodies_are_refused_on_public_routes_too(api) -> None:
    huge = '{"email":"' + "a" * 300_000 + '"}'
    result = api.call("POST", "/auth/login", role=None, raw_body=huge)
    assert result.status == 413


# E4: one clock for "overdue"


def test_deliverables_say_whether_they_are_overdue_by_the_database_clock(api, conn, today) -> None:
    project = _project(conn, "Overdue check")
    cases = {
        "Due yesterday, open": ("in_progress", -1, True),
        "Due today, open": ("not_started", 0, False),
        "Due tomorrow, open": ("blocked", 1, False),
        "Due long ago, done": ("done", -30, False),
        "Due long ago, blocked": ("blocked", -30, True),
    }
    for title, (status, due, _) in cases.items():
        _deliverable(conn, project, title, status=status, due=due)
    listed = api.get("/deliverables", query={"project_id": project}, role="viewer").body["items"]
    assert {item["title"]: item["is_overdue"] for item in listed} == {
        title: overdue for title, (_, _, overdue) in cases.items()
    }
    assert {item["as_of"] for item in listed} == {today.isoformat()}
    one = api.get(f"/deliverables/{listed[0]['id']}").body
    assert one["is_overdue"] == listed[0]["is_overdue"] and one["as_of"] == today.isoformat()


def test_changing_a_deliverable_returns_its_new_overdue_state(api, conn) -> None:
    project = _project(conn, "Overdue transitions")
    late = _deliverable(conn, project, "Late", status="in_progress", due=-5)
    assert api.put(f"/deliverables/{late}", {"status": "done"}).body["is_overdue"] is False
    assert api.put(f"/deliverables/{late}", {"status": "blocked"}).body["is_overdue"] is True


def test_projects_say_whether_they_are_overdue_by_the_database_clock(api, conn, today) -> None:
    cases = {
        "Past, active": ("active", -1, True),
        "Past, on hold": ("on_hold", -1, True),
        "Past, planned": ("planned", -1, True),
        "Past, completed": ("completed", -1, False),
        "Past, cancelled": ("cancelled", -1, False),
        "Ends today": ("active", 0, False),
        "Future": ("active", 5, False),
    }
    for name, (status, end, _) in cases.items():
        _project(conn, name, status=status, end=end)
    listed = api.get("/projects", query={"department": "Test"}, role="viewer").body["items"]
    assert {item["name"]: item["is_overdue"] for item in listed} == {
        name: overdue for name, (_, _, overdue) in cases.items()
    }
    assert {item["as_of"] for item in listed} == {today.isoformat()}
    detail = api.get(f"/projects/{listed[0]['id']}").body
    assert detail["as_of"] == today.isoformat() and "is_overdue" in detail


def test_lists_and_the_dashboard_agree_on_overdue(api) -> None:
    status = api.get("/insights/project-status").body
    overdue_on_dashboard = {item["id"] for item in status["items"] if item["health"] == "overdue"}
    projects = api.get("/projects", query={"limit": 100}).body["items"]
    assert {p["id"] for p in projects if p["is_overdue"]} == overdue_on_dashboard
    assert {p["as_of"] for p in projects} == {status["as_of"]}
    progress = api.get("/insights/deliverables").body["items"]
    for row in progress:
        listed = api.get(
            "/deliverables", query={"project_id": row["project_id"], "limit": 100}
        ).body["items"]
        assert sum(item["is_overdue"] for item in listed) == row["overdue"]


def test_the_database_clock_is_utc(conn) -> None:
    row = conn.execute(
        "SELECT CURRENT_DATE AS today, (now() AT TIME ZONE 'UTC')::date AS utc_today"
    ).fetchone()
    assert row["today"] == row["utc_today"]


# E5: names and departments ignore case


PROJECT = {"name": "Apollo Launch", "department": "Space", "start_date": "2026-01-01",
           "end_date": "2026-06-30"}


@pytest.mark.parametrize("variant", ["apollo launch", "APOLLO LAUNCH", "Apollo launch"])
def test_a_project_name_that_differs_only_by_case_is_a_409_on_name(api, variant: str) -> None:
    assert api.post("/projects", PROJECT).status == 201
    result = api.post("/projects", {**PROJECT, "name": variant})
    assert result.status == 409
    assert result.error["code"] == "duplicate"
    assert result.error["details"] == [{"field": "name", "message": "already exists"}]


def test_renaming_into_another_projects_name_in_another_case_is_a_409(api) -> None:
    api.post("/projects", PROJECT)
    other = api.post("/projects", {**PROJECT, "name": "Gemini"}).body
    result = api.put(f"/projects/{other['id']}", {"name": "APOLLO LAUNCH"})
    assert result.status == 409
    assert result.fields == {"name"}
    # the failed rename was rolled back and the row still works
    assert api.get(f"/projects/{other['id']}").body["name"] == "Gemini"


def test_a_project_can_change_the_case_of_its_own_name(api) -> None:
    created = api.post("/projects", PROJECT).body
    renamed = api.put(f"/projects/{created['id']}", {"name": "APOLLO Launch"})
    assert renamed.status == 200
    assert renamed.body["name"] == "APOLLO Launch"


def test_a_department_takes_the_spelling_that_already_exists(api, conn) -> None:
    created = api.post("/projects", {**PROJECT, "department": "eNgInEeRiNg"})
    assert created.body["department"] == "Engineering"
    person = api.post("/resources", {"full_name": "Case Person", "email": "case@acme.test",
                                     "department": "OPERATIONS"})
    assert person.body["department"] == "Operations"
    updated = api.put(f"/projects/{created.body['id']}", {"department": "marketing"})
    assert updated.body["department"] == "Marketing"
    moved = api.put(f"/resources/{person.body['id']}", {"department": "finance"})
    assert moved.body["department"] == "Finance"


def test_a_new_department_is_stored_as_written_and_then_reused(api) -> None:
    first = api.post("/projects", {**PROJECT, "department": "Quantum Lab"}).body
    assert first["department"] == "Quantum Lab"
    # a person in the same department, typed differently, joins the project's spelling
    person = api.post("/resources", {"full_name": "Lab Person", "email": "lab@acme.test",
                                     "department": "quantum lab"})
    assert person.body["department"] == "Quantum Lab"
    second = api.post("/projects", {**PROJECT, "name": "Second", "department": "QUANTUM LAB"})
    assert second.body["department"] == "Quantum Lab"


def test_the_only_user_of_a_department_can_correct_its_case(api) -> None:
    created = api.post("/projects", {**PROJECT, "department": "research"}).body
    corrected = api.put(f"/projects/{created['id']}", {"department": "Research"})
    assert corrected.body["department"] == "Research"
    person = api.post("/resources", {"full_name": "Solo", "email": "solo@acme.test",
                                     "department": "astro"}).body
    fixed = api.put(f"/resources/{person['id']}", {"department": "Astro"})
    assert fixed.body["department"] == "Astro"


def test_the_department_filter_ignores_case(api) -> None:
    for spelling in ("marketing", "MARKETING", "Marketing"):
        assert api.get("/projects", query={"department": spelling}).body["total"] == 2
    for spelling in ("engineering", "ENGINEERING"):
        assert api.get("/resources", query={"department": spelling}).body["total"] == 4
    assert api.get("/projects", query={"department": "Market"}).body["total"] == 0


# E6: dates between 2000-01-01 and 2100-12-31


RANGE_MESSAGE = "must be between 2000-01-01 and 2100-12-31"


@pytest.mark.parametrize("day", ["1999-12-31", "2101-01-01", "0001-01-01", "9999-12-31"])
def test_dates_outside_the_range_are_field_errors(api, conn, day: str) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    person = id_of(conn, "resources", "email", "ben.carter@acme.test")
    cases = {
        "/projects": ({**PROJECT, "start_date": day, "end_date": day}, {"start_date", "end_date"}),
        "/deliverables": ({"project_id": portal, "title": "T", "due_date": day}, {"due_date"}),
        "/allocations": (
            {"resource_id": person, "project_id": portal, "allocation_pct": 10,
             "start_date": day, "end_date": day},
            {"start_date", "end_date"},
        ),
        "/budgets": (
            {"project_id": portal, "category": "other", "amount": 1, "spent_on": day},
            {"spent_on"},
        ),
    }
    for path, (body, fields) in cases.items():
        result = api.post(path, body)
        assert result.status == 400, path
        assert result.fields == fields, path
        assert {detail["message"] for detail in result.error["details"]} == {RANGE_MESSAGE}


def test_the_first_and_last_allowed_days_are_accepted(api) -> None:
    edges = {"start_date": "2000-01-01", "end_date": "2100-12-31"}
    created = api.post("/projects", {**PROJECT, **edges})
    assert created.status == 201
    assert (created.body["start_date"], created.body["end_date"]) == ("2000-01-01", "2100-12-31")


def test_an_update_cannot_move_a_date_out_of_range(api) -> None:
    created = api.post("/projects", PROJECT).body
    result = api.put(f"/projects/{created['id']}", {"end_date": "2150-01-01"})
    assert result.status == 400
    assert result.error["details"] == [{"field": "end_date", "message": RANGE_MESSAGE}]


@pytest.mark.parametrize(
    ("path", "param"),
    [("/allocations", "active_on"), ("/budgets", "spent_from"), ("/budgets", "spent_to"),
     ("/insights/allocation", "on"), ("/insights/over-allocated", "from")],
)
def test_date_query_parameters_have_the_same_range(api, path: str, param: str) -> None:
    result = api.get(path, query={param: "1899-01-01"})
    assert result.status == 400
    assert result.fields == {param}
    assert api.get(path, query={param: "2026-01-01"}).status == 200


# E7: control characters


CONTROL = "must not contain control characters, line breaks or tabs"
CONTROL_MULTILINE = "must not contain control characters other than line breaks and tabs"


@pytest.mark.parametrize("char", ["\x00", "\x01", "\x1b", "\x7f", "\x85", "\n", "\t", "\r"])
def test_control_characters_in_single_line_text_are_field_errors(api, char: str) -> None:
    result = api.post(
        "/projects", {**PROJECT, "name": f"Apollo{char}Launch", "department": f"Sp{char}ace"}
    )
    assert result.status == 400
    assert result.error["code"] == "validation_error"
    assert result.error["details"] == [
        {"field": "name", "message": CONTROL}, {"field": "department", "message": CONTROL},
    ]


def test_line_breaks_and_tabs_are_allowed_in_descriptions_only(api, conn) -> None:
    notes = "Line one\nLine two\r\n\tindented"
    created = api.post("/projects", {**PROJECT, "description": notes})
    assert created.status == 201
    assert created.body["description"] == notes
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    deliverable = api.post("/deliverables", {"project_id": portal, "title": "Notes",
                                             "due_date": "2026-05-01", "description": notes})
    assert deliverable.status == 201
    entry = api.post("/budgets", {"project_id": portal, "category": "other", "amount": 5,
                                  "spent_on": "2026-05-01", "description": notes})
    assert entry.status == 201


@pytest.mark.parametrize("char", ["\x00", "\x08", "\x1f", "\x7f"])
def test_other_control_characters_in_descriptions_are_field_errors(api, char: str) -> None:
    result = api.post("/projects", {**PROJECT, "description": f"before{char}after"})
    assert result.status == 400
    assert result.error["details"] == [{"field": "description", "message": CONTROL_MULTILINE}]


def test_every_text_field_refuses_nul(api, conn) -> None:
    portal = id_of(conn, "projects", "name", "Customer Portal Revamp")
    person = id_of(conn, "resources", "email", "ben.carter@acme.test")
    nul = "a\x00b"
    cases = {
        "/deliverables": ({"project_id": portal, "title": nul, "due_date": "2026-05-01"}, "title"),
        "/resources": ({"full_name": "N", "email": "n@acme.test", "job_title": nul}, "job_title"),
        "/allocations": (
            {"resource_id": person, "project_id": portal, "allocation_pct": 5,
             "start_date": "2026-01-01", "end_date": "2026-02-01", "role_on_project": nul},
            "role_on_project",
        ),
        "/auth/users": (
            {"email": "nul@acme.test", "full_name": nul, "password": "Tangerine-Sky-42",
             "role": "viewer"},
            "full_name",
        ),
    }
    for path, (body, field) in cases.items():
        result = api.post(path, body)
        assert result.status == 400, path
        assert result.fields == {field}, path


def test_an_update_cannot_put_a_control_character_in(api) -> None:
    created = api.post("/projects", PROJECT).body
    result = api.put(f"/projects/{created['id']}", {"name": "Bad\x00Name"})
    assert result.status == 400
    assert result.fields == {"name"}


@pytest.mark.parametrize("path", ["/projects", "/resources", "/deliverables", "/budgets"])
def test_control_characters_in_a_search_are_a_400(api, path: str) -> None:
    result = api.get(path, query={"q": "abc\x00def"})
    assert result.status == 400
    assert result.fields == {"q"}


def test_control_characters_in_a_text_filter_are_a_400(api) -> None:
    result = api.get("/projects", query={"department": "Eng\x00ineering"})
    assert result.status == 400
    assert result.fields == {"department"}


def test_has_control_characters() -> None:
    assert has_control_characters("a\x00b")
    assert has_control_characters("a\nb")
    assert not has_control_characters("a\nb\tc\r", multiline=True)
    assert has_control_characters("a\x0bb", multiline=True)
    assert not has_control_characters("Zoë — 東京 ✓")
    assert not has_control_characters("")
    assert not has_control_characters((date(2026, 1, 1) + timedelta(days=1)).isoformat())


def test_a_text_field_with_a_minimum_length_names_it() -> None:
    from acme.core.http import BadRequest
    from acme.core.validation import string, validate

    fields = (string("code", required=True, min_length=4),)
    assert validate({"code": "abcd"}, fields) == {"code": "abcd"}
    with pytest.raises(BadRequest) as caught:
        validate({"code": "abc"}, fields)
    assert caught.value.details == [{"field": "code", "message": "must be at least 4 characters"}]
