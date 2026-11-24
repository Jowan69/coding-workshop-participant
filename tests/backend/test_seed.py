"""The demo data tells the intended story and is only added to empty tables."""

from __future__ import annotations

import logging
from datetime import timedelta

from acme import seed
from conftest import SEED_PASSWORD

PEAK_BY_RESOURCE = """
SELECT r.email, max(daily.total) AS peak
FROM resources r
JOIN LATERAL (
    SELECT sum(a.allocation_pct) AS total
    FROM allocations s
    JOIN allocations a ON a.resource_id = r.id
     AND a.start_date <= s.start_date AND a.end_date >= s.start_date
    WHERE s.resource_id = r.id
    GROUP BY s.start_date
) daily ON true
GROUP BY r.email
"""


def _count(conn, table: str) -> int:
    return conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]


def test_seed_sizes(conn) -> None:
    assert _count(conn, "users") == 4
    assert _count(conn, "projects") == 6
    assert _count(conn, "resources") == 8
    assert 18 <= _count(conn, "deliverables") <= 22
    assert 18 <= _count(conn, "budget_entries") <= 22
    departments = conn.execute("SELECT count(DISTINCT department) AS n FROM projects").fetchone()
    assert departments["n"] == 4


def test_seed_users_have_the_four_roles(conn) -> None:
    rows = conn.execute("SELECT email, role FROM users ORDER BY email").fetchall()
    assert {r["email"]: r["role"] for r in rows} == {
        "admin@acme.test": "admin",
        "lead@acme.test": "contributor",
        "manager@acme.test": "manager",
        "viewer@acme.test": "viewer",
    }


def test_seed_dates_are_relative_to_today(conn) -> None:
    row = conn.execute(
        "SELECT end_date, CURRENT_DATE AS today FROM projects WHERE name = 'Data Center Migration'"
    ).fetchone()
    assert row["end_date"] == row["today"] - timedelta(days=10)


def test_seed_project_scenarios(conn) -> None:
    past_deadline = conn.execute(
        "SELECT name FROM projects WHERE status = 'active' AND end_date < CURRENT_DATE"
    ).fetchall()
    assert [r["name"] for r in past_deadline] == ["Data Center Migration"]

    blocked = conn.execute(
        "SELECT p.name FROM deliverables d JOIN projects p ON p.id = d.project_id "
        "WHERE d.status = 'blocked'"
    ).fetchall()
    assert [r["name"] for r in blocked] == ["Mobile Banking App"]

    over_budget = conn.execute(
        "SELECT p.name FROM projects p JOIN budget_entries b ON b.project_id = p.id "
        "GROUP BY p.id HAVING sum(b.amount) > p.budget_planned"
    ).fetchall()
    assert [r["name"] for r in over_budget] == ["Brand Refresh Campaign"]

    statuses = conn.execute("SELECT name, status FROM projects").fetchall()
    by_status = {r["status"]: r["name"] for r in statuses if r["status"] != "active"}
    assert by_status == {"completed": "ERP Finance Upgrade", "planned": "Market Expansion Study"}


def test_seed_done_deliverables_are_stamped(conn) -> None:
    mismatched = conn.execute(
        "SELECT count(*) AS n FROM deliverables "
        "WHERE (status = 'done') <> (completed_at IS NOT NULL)"
    ).fetchone()
    assert mismatched["n"] == 0


def test_seed_dependency_chain_is_three_deep(conn) -> None:
    depth = conn.execute(
        """
        WITH RECURSIVE chain (id, depth) AS (
            SELECT d.id, 0 FROM deliverables d WHERE d.title = 'App store submission'
            UNION ALL
            SELECT dd.depends_on_id, c.depth + 1
            FROM deliverable_dependencies dd JOIN chain c ON dd.deliverable_id = c.id
        )
        SELECT max(depth) AS depth FROM chain
        """
    ).fetchone()
    assert depth["depth"] == 3


def test_seed_exactly_two_people_exceed_100_percent(conn) -> None:
    peaks = {r["email"]: r["peak"] for r in conn.execute(PEAK_BY_RESOURCE).fetchall()}
    over = sorted(email for email, peak in peaks.items() if peak > 100)
    assert over == ["aisha.khan@acme.test", "farid.haddad@acme.test"]


def test_seed_users_can_log_in(api) -> None:
    result = api.post(
        "/auth/login", {"email": "viewer@acme.test", "password": SEED_PASSWORD}, role=None
    )
    assert result.status == 200


def test_seed_never_duplicates(conn, database) -> None:
    before = {t: _count(conn, t) for t in ("users", "projects", "deliverables", "budget_entries")}
    seed.run(conn, database.SETTINGS)
    after = {t: _count(conn, t) for t in before}
    assert after == before


def test_seed_skips_users_without_a_password(conn, database, caplog) -> None:
    conn.execute("DELETE FROM budget_entries")
    conn.execute("UPDATE projects SET owner_id = NULL")
    conn.execute("DELETE FROM users")
    no_password = database.SETTINGS.__class__(
        **{**database.SETTINGS.__dict__, "seed_password": None}
    )
    caplog.set_level(logging.WARNING, logger="acme.seed")
    seed.run(conn, no_password)
    assert _count(conn, "users") == 0
    assert "SEED_PASSWORD is not set" in caplog.text
    assert _count(conn, "budget_entries") == len(seed.BUDGET_ENTRIES)


def test_seed_fills_an_empty_database(conn, database) -> None:
    for table in ("budget_entries", "allocations", "deliverables", "projects", "resources"):
        conn.execute(f"DELETE FROM {table}")
    seed.run(conn, database.SETTINGS)
    assert _count(conn, "projects") == len(seed.PROJECTS)
    assert _count(conn, "deliverable_dependencies") == len(seed.DEPENDENCIES)
    assert _count(conn, "allocations") == len(seed.ALLOCATIONS)
