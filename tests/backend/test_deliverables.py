"""Deliverables: CRUD, completed_at stamping, dependencies, cycle checks and roles."""

from __future__ import annotations

import pytest

from conftest import id_of


@pytest.fixture
def ids(conn):
    """Seeded ids by name."""

    def deliverable(title: str) -> int:
        return id_of(conn, "deliverables", "title", title)

    return {
        "portal": id_of(conn, "projects", "name", "Customer Portal Revamp"),
        "mobile": id_of(conn, "projects", "name", "Mobile Banking App"),
        "aisha": id_of(conn, "resources", "email", "aisha.khan@acme.test"),
        "d": deliverable,
    }


def _new(ids, **change):
    return {"project_id": ids["portal"], "title": "Release notes", "due_date": "2026-09-01",
            **change}


def test_list_and_filters(api, ids) -> None:
    everything = api.get("/deliverables", role="viewer").body
    assert everything["total"] == 21
    dues = [d["due_date"] for d in everything["items"]]
    assert dues == sorted(dues)
    assert api.get("/deliverables", query={"project_id": ids["mobile"]}).body["total"] == 5
    assert api.get("/deliverables", query={"status": "blocked"}).body["total"] == 1
    assert api.get("/deliverables", query={"assignee_id": ids["aisha"]}).body["total"] == 2
    assert api.get("/deliverables", query={"q": "review"}).body["total"] == 1
    page = api.get("/deliverables", query={"limit": 5, "offset": 20, "sort": "-title"}).body
    assert (len(page["items"]), page["total"]) == (1, 21)


def test_create_and_get(api, ids) -> None:
    result = api.post("/deliverables", _new(ids, assignee_id=ids["aisha"]), role="contributor")
    assert result.status == 201
    assert result.body["status"] == "not_started"
    assert result.body["completed_at"] is None
    assert api.get(f"/deliverables/{result.body['id']}").body["title"] == "Release notes"


def test_create_validation(api, ids) -> None:
    missing = api.post("/deliverables", {})
    assert missing.fields == {"project_id", "title", "due_date"}
    refs = api.post("/deliverables", _new(ids, project_id=999999, assignee_id=888888))
    assert refs.status == 400
    assert refs.fields == {"project_id", "assignee_id"}
    assert api.post("/deliverables", _new(ids, status="finished")).fields == {"status"}


def test_creating_as_done_stamps_completed_at(api, ids) -> None:
    result = api.post("/deliverables", _new(ids, status="done"))
    assert result.body["completed_at"] is not None


def test_completed_at_follows_status(api, ids) -> None:
    item = f"/deliverables/{ids['d']('Single sign-on integration')}"
    done = api.put(item, {"status": "done"}).body
    assert done["completed_at"] is not None
    still_done = api.put(item, {"title": "SSO integration"}).body
    assert still_done["completed_at"] == done["completed_at"]
    reopened = api.put(item, {"status": "in_progress"}).body
    assert reopened["completed_at"] is None


def test_project_cannot_change_but_assignee_can_be_cleared(api, ids) -> None:
    item = f"/deliverables/{ids['d']('Usage dashboard')}"
    moved = api.put(item, {"project_id": ids["mobile"]})
    assert moved.status == 400
    assert moved.fields == {"project_id"}
    same = api.put(item, {"project_id": ids["portal"], "assignee_id": None})
    assert same.status == 200
    assert same.body["assignee_id"] is None


def test_delete_needs_manager(api, ids) -> None:
    item = f"/deliverables/{ids['d']('Usage dashboard')}"
    assert api.delete(item, role="contributor").status == 403
    assert api.delete(item, role="manager").status == 204
    assert api.get(item).status == 404


def test_list_dependencies(api, ids) -> None:
    result = api.get(f"/deliverables/{ids['d']('Security review')}/dependencies", role="viewer")
    assert result.status == 200
    assert [d["title"] for d in result.body["items"]] == ["Payments integration"]
    assert result.body["total"] == 1
    assert api.get("/deliverables/999999/dependencies").status == 404


def test_add_and_remove_a_dependency(api, ids) -> None:
    push, contract = ids["d"]("Push notifications"), ids["d"]("API contract")
    added = api.post(f"/deliverables/{push}/dependencies", {"depends_on_id": contract},
                     role="contributor")
    assert added.status == 201
    assert added.body["depends_on"]["id"] == contract
    duplicate = api.post(f"/deliverables/{push}/dependencies", {"depends_on_id": contract})
    assert duplicate.status == 409
    link = f"/deliverables/{push}/dependencies/{contract}"
    assert api.delete(link, role="contributor").status == 403
    assert api.delete(link, role="manager").status == 204
    assert api.delete(link).status == 404


def test_dependency_rules(api, ids) -> None:
    contract = ids["d"]("API contract")
    deps = f"/deliverables/{contract}/dependencies"
    self_link = api.post(deps, {"depends_on_id": contract})
    assert self_link.status == 400
    assert "itself" in self_link.error["message"]
    other_project = api.post(deps, {"depends_on_id": ids["d"]("Usage dashboard")})
    assert other_project.status == 400
    assert "another project" in other_project.error["message"]
    missing = api.post(deps, {"depends_on_id": 999999})
    assert missing.status == 400
    assert missing.fields == {"depends_on_id"}
    assert api.post(deps, {}).fields == {"depends_on_id"}
    assert api.post("/deliverables/999999/dependencies", {"depends_on_id": contract}).status == 404
    push = {"depends_on_id": ids["d"]("Push notifications")}
    assert api.post(deps, push, role="viewer").status == 403


def test_cycles_are_refused(api, ids) -> None:
    # Chain: App store submission -> Security review -> Payments integration -> API contract
    contract = ids["d"]("API contract")
    store = ids["d"]("App store submission")
    result = api.post(f"/deliverables/{contract}/dependencies", {"depends_on_id": store})
    assert result.status == 400
    assert "cycle" in result.error["message"]
    direct = api.post(
        f"/deliverables/{ids['d']('Payments integration')}/dependencies",
        {"depends_on_id": ids["d"]("Security review")},
    )
    assert direct.status == 400


def test_deleting_a_deliverable_removes_its_links(api, ids, conn) -> None:
    payments = ids["d"]("Payments integration")
    assert api.delete(f"/deliverables/{payments}", role="manager").status == 204
    left = conn.execute(
        "SELECT count(*) AS n FROM deliverable_dependencies "
        "WHERE deliverable_id = %s OR depends_on_id = %s",
        (payments, payments),
    ).fetchone()
    assert left["n"] == 0
