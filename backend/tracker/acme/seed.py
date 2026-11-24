"""Demo data for a fresh database, with dates relative to today so the demo never goes stale.

Each part runs only when its table is empty and looks up what it references by name or
email, so a partly seeded database is completed rather than duplicated.

The story: one healthy project, one past its deadline, one behind schedule with a blocked
deliverable and a three-link dependency chain, one over budget, one completed and one
planned. Two people (Aisha Khan, Farid Haddad) are booked above 100% in overlapping dates.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING

from psycopg import sql

from acme.core import auth

if TYPE_CHECKING:
    import psycopg

    from acme.core.config import Settings

logger = logging.getLogger("acme.seed")

# email, full name, role
USERS = (
    ("admin@acme.test", "Priya Shah", "admin"),
    ("manager@acme.test", "Daniel Okafor", "manager"),
    ("lead@acme.test", "Maria Gonzalez", "contributor"),
    ("viewer@acme.test", "Tom Becker", "viewer"),
)

# email, full name, job title, department, capacity %
RESOURCES = (
    ("aisha.khan@acme.test", "Aisha Khan", "Senior Software Engineer", "Engineering", 100),
    ("ben.carter@acme.test", "Ben Carter", "Backend Engineer", "Engineering", 100),
    ("chloe.martin@acme.test", "Chloe Martin", "UX Designer", "Engineering", 100),
    ("diego.alvarez@acme.test", "Diego Alvarez", "Marketing Specialist", "Marketing", 100),
    ("emma.wilson@acme.test", "Emma Wilson", "Financial Analyst", "Finance", 100),
    ("farid.haddad@acme.test", "Farid Haddad", "Infrastructure Engineer", "Operations", 100),
    ("grace.liu@acme.test", "Grace Liu", "QA Engineer", "Engineering", 50),
    ("henry.osei@acme.test", "Henry Osei", "Project Coordinator", "Operations", 100),
)

# name, department, status, start and end (days from today), planned budget, owner, description
PROJECTS = (
    (
        "Customer Portal Revamp", "Engineering", "active", -60, 90, "250000.00",
        "manager@acme.test",
        "Rebuild the customer self-service portal with single sign-on and a usage dashboard.",
    ),
    (
        "Data Center Migration", "Operations", "active", -150, -10, "400000.00",
        "manager@acme.test",
        "Move the remaining on-premise workloads to the new co-located data center.",
    ),
    (
        "Mobile Banking App", "Engineering", "active", -90, 30, "180000.00",
        "lead@acme.test",
        "Ship the first release of the mobile banking app on iOS and Android.",
    ),
    (
        "Brand Refresh Campaign", "Marketing", "active", -75, 45, "80000.00",
        "manager@acme.test",
        "Refresh the visual identity and relaunch the website and campaign materials.",
    ),
    (
        "ERP Finance Upgrade", "Finance", "completed", -200, -30, "150000.00",
        "manager@acme.test",
        "Upgrade the finance modules of the ERP system to the current release.",
    ),
    (
        "Market Expansion Study", "Marketing", "planned", 20, 140, "60000.00",
        "lead@acme.test",
        "Assess demand and entry options for two new regional markets.",
    ),
)

# project, title, status, due (days from today), assignee email
DELIVERABLES = (
    ("Customer Portal Revamp", "Requirements sign-off", "done", -45, "chloe.martin@acme.test"),
    ("Customer Portal Revamp", "Clickable UX prototype", "done", -20, "chloe.martin@acme.test"),
    ("Customer Portal Revamp", "Single sign-on integration", "in_progress", 15,
     "aisha.khan@acme.test"),
    ("Customer Portal Revamp", "Usage dashboard", "not_started", 50, "ben.carter@acme.test"),
    ("Data Center Migration", "Legacy server inventory", "done", -120, "henry.osei@acme.test"),
    ("Data Center Migration", "Network cutover plan", "done", -60, "farid.haddad@acme.test"),
    ("Data Center Migration", "Database migration", "in_progress", -15, "farid.haddad@acme.test"),
    ("Data Center Migration", "Decommission old racks", "not_started", -10,
     "henry.osei@acme.test"),
    ("Mobile Banking App", "API contract", "done", -60, "ben.carter@acme.test"),
    ("Mobile Banking App", "Payments integration", "blocked", -10, "ben.carter@acme.test"),
    ("Mobile Banking App", "Security review", "not_started", 10, "farid.haddad@acme.test"),
    ("Mobile Banking App", "App store submission", "not_started", 25, "grace.liu@acme.test"),
    ("Mobile Banking App", "Push notifications", "in_progress", -5, "aisha.khan@acme.test"),
    ("Brand Refresh Campaign", "Brand guidelines", "done", -40, "diego.alvarez@acme.test"),
    ("Brand Refresh Campaign", "Website refresh", "in_progress", 10, "chloe.martin@acme.test"),
    ("Brand Refresh Campaign", "Launch event", "not_started", 40, "diego.alvarez@acme.test"),
    ("ERP Finance Upgrade", "General ledger migration", "done", -90, "emma.wilson@acme.test"),
    ("ERP Finance Upgrade", "Reporting cutover", "done", -45, "emma.wilson@acme.test"),
    ("ERP Finance Upgrade", "Finance team training", "done", -32, "henry.osei@acme.test"),
    ("Market Expansion Study", "Market sizing", "not_started", 50, "diego.alvarez@acme.test"),
    ("Market Expansion Study", "Entry recommendation", "not_started", 130, None),
)

# project, deliverable, depends on (same project)
DEPENDENCIES = (
    ("Mobile Banking App", "Payments integration", "API contract"),
    ("Mobile Banking App", "Security review", "Payments integration"),
    ("Mobile Banking App", "App store submission", "Security review"),
    ("Customer Portal Revamp", "Usage dashboard", "Single sign-on integration"),
)

# resource email, project, allocation %, start and end (days from today), role on project
ALLOCATIONS = (
    ("aisha.khan@acme.test", "Customer Portal Revamp", 60, -60, 90, "Tech lead"),
    ("aisha.khan@acme.test", "Mobile Banking App", 60, -90, 30, "Mobile engineer"),
    ("ben.carter@acme.test", "Customer Portal Revamp", 50, -60, 90, "Backend engineer"),
    ("ben.carter@acme.test", "Mobile Banking App", 40, -30, 30, "Payments engineer"),
    ("chloe.martin@acme.test", "Customer Portal Revamp", 50, -60, 30, "UX designer"),
    ("chloe.martin@acme.test", "Brand Refresh Campaign", 30, -75, 45, "Web designer"),
    ("diego.alvarez@acme.test", "Brand Refresh Campaign", 80, -75, 45, "Campaign lead"),
    ("diego.alvarez@acme.test", "Market Expansion Study", 20, 20, 140, "Market analyst"),
    ("emma.wilson@acme.test", "ERP Finance Upgrade", 70, -200, -30, "Finance lead"),
    ("emma.wilson@acme.test", "Data Center Migration", 30, -150, -10, "Cost tracking"),
    ("farid.haddad@acme.test", "Data Center Migration", 70, -150, 20, "Migration lead"),
    ("farid.haddad@acme.test", "Mobile Banking App", 50, -20, 30, "Security reviewer"),
    ("grace.liu@acme.test", "Mobile Banking App", 40, -60, 30, "QA engineer"),
    ("henry.osei@acme.test", "Data Center Migration", 50, -150, -10, "Coordinator"),
    ("henry.osei@acme.test", "ERP Finance Upgrade", 40, -200, -30, "Training coordinator"),
)

# project, category, description, amount, spent (days from today)
BUDGET_ENTRIES = (
    ("Customer Portal Revamp", "labor", "Sprint team, first two months", "52000.00", -50),
    ("Customer Portal Revamp", "software", "Single sign-on licences", "18500.00", -40),
    ("Customer Portal Revamp", "hardware", "Test devices", "4200.00", -25),
    ("Customer Portal Revamp", "labor", "Contract front-end developer", "15000.00", -10),
    ("Data Center Migration", "hardware", "Racks and network gear", "120000.00", -130),
    ("Data Center Migration", "services", "Migration partner, phase 1", "95000.00", -100),
    ("Data Center Migration", "software", "Monitoring tools", "8000.00", -80),
    ("Data Center Migration", "labor", "Weekend cutover crews", "80000.00", -60),
    ("Data Center Migration", "services", "Migration partner, phase 2", "45000.00", -20),
    ("Mobile Banking App", "labor", "Mobile squad", "60000.00", -70),
    ("Mobile Banking App", "software", "Developer accounts and SDKs", "12000.00", -50),
    ("Mobile Banking App", "hardware", "Device lab", "6500.00", -30),
    ("Mobile Banking App", "services", "Penetration test booking", "25000.00", -15),
    ("Brand Refresh Campaign", "services", "Design agency", "42000.00", -60),
    ("Brand Refresh Campaign", "other", "Photo shoot", "18500.00", -35),
    ("Brand Refresh Campaign", "labor", "Copywriting", "24000.00", -20),
    ("Brand Refresh Campaign", "software", "Website CMS licence", "12000.00", -5),
    ("ERP Finance Upgrade", "software", "ERP upgrade licences", "65000.00", -180),
    ("ERP Finance Upgrade", "labor", "Implementation team", "52300.00", -120),
    ("ERP Finance Upgrade", "services", "Vendor support", "25000.00", -60),
)


def run(conn: psycopg.Connection, settings: Settings) -> None:
    """Seed every empty table, in dependency order."""
    today = conn.execute("SELECT CURRENT_DATE AS today").fetchone()["today"]
    _seed_users(conn, settings)
    _seed_resources(conn)
    _seed_projects(conn, today)
    _seed_deliverables(conn, today)
    _seed_allocations(conn, today)
    _seed_budget_entries(conn, today)


def _is_empty(conn: psycopg.Connection, table: str) -> bool:
    query = sql.SQL("SELECT NOT EXISTS (SELECT 1 FROM {}) AS empty").format(sql.Identifier(table))
    return conn.execute(query).fetchone()["empty"]


def _ids(conn: psycopg.Connection, table: str, key: str) -> dict[str, int]:
    query = sql.SQL("SELECT id, {} AS key FROM {}").format(
        sql.Identifier(key), sql.Identifier(table)
    )
    return {row["key"]: row["id"] for row in conn.execute(query).fetchall()}


def _day(today: date, offset: int) -> date:
    return today + timedelta(days=offset)


def _seed_users(conn: psycopg.Connection, settings: Settings) -> None:
    if not _is_empty(conn, "users"):
        return
    if not settings.seed_password:
        logger.warning("SEED_PASSWORD is not set, so the demo users were not created")
        return
    rows = [
        (email, name, role, auth.hash_password(settings.seed_password))
        for email, name, role in USERS
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO users (email, full_name, role, password_hash) VALUES (%s, %s, %s, %s)",
            rows,
        )


def _seed_resources(conn: psycopg.Connection) -> None:
    if not _is_empty(conn, "resources"):
        return
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO resources (email, full_name, job_title, department, capacity_pct) "
            "VALUES (%s, %s, %s, %s, %s)",
            RESOURCES,
        )


def _seed_projects(conn: psycopg.Connection, today: date) -> None:
    if not _is_empty(conn, "projects"):
        return
    owners = _ids(conn, "users", "email")
    rows = [
        (name, dept, status, _day(today, start), _day(today, end), Decimal(budget),
         owners.get(owner), description)
        for name, dept, status, start, end, budget, owner, description in PROJECTS
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO projects (name, department, status, start_date, end_date, "
            "budget_planned, owner_id, description) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            rows,
        )


def _seed_deliverables(conn: psycopg.Connection, today: date) -> None:
    if not _is_empty(conn, "deliverables"):
        return
    projects = _ids(conn, "projects", "name")
    people = _ids(conn, "resources", "email")
    created: dict[tuple[str, str], int] = {}
    for project, title, status, due, assignee in DELIVERABLES:
        if project not in projects:
            continue
        due_date = _day(today, due)
        completed_at = None
        if status == "done":
            completed_at = datetime.combine(due_date - timedelta(days=1), time(16), timezone.utc)
        row = conn.execute(
            "INSERT INTO deliverables (project_id, title, status, due_date, completed_at, "
            "assignee_id) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (projects[project], title, status, due_date, completed_at, people.get(assignee)),
        ).fetchone()
        created[(project, title)] = row["id"]
    links = [
        (created[(project, title)], created[(project, depends_on)])
        for project, title, depends_on in DEPENDENCIES
        if (project, title) in created and (project, depends_on) in created
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO deliverable_dependencies (deliverable_id, depends_on_id) VALUES (%s, %s)",
            links,
        )


def _seed_allocations(conn: psycopg.Connection, today: date) -> None:
    if not _is_empty(conn, "allocations"):
        return
    projects = _ids(conn, "projects", "name")
    people = _ids(conn, "resources", "email")
    rows = [
        (people[email], projects[project], pct, _day(today, start), _day(today, end), role)
        for email, project, pct, start, end, role in ALLOCATIONS
        if email in people and project in projects
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO allocations (resource_id, project_id, allocation_pct, start_date, "
            "end_date, role_on_project) VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )


def _seed_budget_entries(conn: psycopg.Connection, today: date) -> None:
    if not _is_empty(conn, "budget_entries"):
        return
    projects = _ids(conn, "projects", "name")
    recorder = _ids(conn, "users", "email").get("manager@acme.test")
    rows = [
        (projects[project], category, description, Decimal(amount), _day(today, spent), recorder)
        for project, category, description, amount, spent in BUDGET_ENTRIES
        if project in projects
    ]
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO budget_entries (project_id, category, description, amount, spent_on, "
            "created_by) VALUES (%s, %s, %s, %s, %s, %s)",
            rows,
        )
