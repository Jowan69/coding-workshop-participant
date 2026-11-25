"""Phase 6, part F: API rules behind the interface fixes (F2, F9)."""

from __future__ import annotations

import pytest

from acme.core import auth
from acme.core.http import Response, Unauthorized, to_lambda
from conftest import id_of


@pytest.fixture
def linked(conn) -> tuple[int, int]:
    """(deliverable, the one it depends on) from the seeded chain."""
    return (
        id_of(conn, "deliverables", "title", "Security review"),
        id_of(conn, "deliverables", "title", "Payments integration"),
    )


# F2: contributors may remove a dependency link


@pytest.mark.parametrize("role", ["contributor", "manager", "admin"])
def test_contributors_and_above_can_remove_a_dependency_link(api, conn, linked, role: str) -> None:
    deliverable, upstream = linked
    result = api.delete(f"/deliverables/{deliverable}/dependencies/{upstream}", role=role)
    assert result.status == 204
    left = conn.execute(
        "SELECT count(*) AS n FROM deliverable_dependencies "
        "WHERE deliverable_id = %s AND depends_on_id = %s",
        (deliverable, upstream),
    ).fetchone()["n"]
    assert left == 0
    # no record was deleted, only the link
    assert api.get(f"/deliverables/{deliverable}").status == 200
    assert api.get(f"/deliverables/{upstream}").status == 200


def test_viewers_cannot_remove_a_dependency_link(api, linked) -> None:
    deliverable, upstream = linked
    result = api.delete(f"/deliverables/{deliverable}/dependencies/{upstream}", role="viewer")
    assert result.status == 403
    anonymous = api.delete(f"/deliverables/{deliverable}/dependencies/{upstream}", role=None)
    assert anonymous.status == 401


def test_deleting_a_deliverable_still_needs_a_manager(api, linked) -> None:
    deliverable, _ = linked
    assert api.delete(f"/deliverables/{deliverable}", role="contributor").status == 403
    assert api.delete(f"/deliverables/{deliverable}", role="manager").status == 204


def test_the_unlink_route_is_the_only_delete_below_manager() -> None:
    import function

    below_manager = {
        route.template for route in function.ROUTER.routes
        if route.method == "DELETE" and route.min_role in ("viewer", "contributor")
    }
    assert below_manager == {"/deliverables/{id}/dependencies/{depends_on_id}"}


# F9: Cache-Control on every response; the article in the token message


def test_every_kind_of_response_says_no_store(api) -> None:
    responses = [
        api.get("/health", role=None),                                   # public 200
        api.get("/projects", role="viewer"),                             # list
        api.get("/projects/999999"),                                     # 404
        api.get("/projects", role=None),                                 # 401
        api.post("/projects", {}, role="viewer"),                        # 403
        api.post("/projects", {}),                                       # 400
        api.call("POST", "/projects", raw_body="{oops"),                 # malformed
        api.get("/nothing-here"),                                        # unknown route
        api.post("/auth/login", {"email": "x@y.test", "password": "wrong-pass-1"}, role=None),
    ]
    for result in responses:
        assert result.headers["Cache-Control"] == "no-store", result.status
        assert result.headers["Content-Type"] == "application/json"


def test_no_content_and_extra_headers_keep_no_store() -> None:
    assert to_lambda(Response(204))["headers"]["Cache-Control"] == "no-store"
    with_extra = to_lambda(Response(429, {}, {"Retry-After": "9"}))["headers"]
    assert with_extra["Cache-Control"] == "no-store" and with_extra["Retry-After"] == "9"


def test_the_token_type_message_uses_the_right_article(database, conn) -> None:
    user = conn.execute("SELECT * FROM users WHERE email = 'admin@acme.test'").fetchone()
    tokens = auth.issue_tokens(user, database.SETTINGS)
    with pytest.raises(Unauthorized) as wrong_refresh:
        auth.decode_token(tokens["access_token"], database.SETTINGS, auth.TYP_REFRESH)
    assert wrong_refresh.value.message == "Expected a refresh token"
    with pytest.raises(Unauthorized) as wrong_access:
        auth.decode_token(tokens["refresh_token"], database.SETTINGS, auth.TYP_ACCESS)
    assert wrong_access.value.message == "Expected an access token"


def test_refresh_with_an_access_token_says_expected_a_refresh_token(api, tokens) -> None:
    result = api.post("/auth/refresh", {"refresh_token": tokens["admin"]}, role=None)
    assert result.status == 401
    assert result.error["message"] == "Expected a refresh token"
