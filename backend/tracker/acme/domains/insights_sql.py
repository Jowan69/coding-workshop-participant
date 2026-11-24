"""The SQL behind /insights: one function per business question, each stating its rule.

Every threshold lives in the block below and reaches the SQL as a query parameter, so a
rule changes in one place. "Today" is always passed in (the handlers read the database's
CURRENT_DATE, the same clock the seed uses), which keeps every query deterministic.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import psycopg

# Thresholds: the only place these numbers live.
SLIP_POINTS = 20  # time elapsed may lead deliverables done by at most this many points
OVER_ALLOCATION_WINDOW_DAYS = 90  # default look-ahead for /insights/over-allocated
CLOSED_PROJECT_STATUSES = ("completed", "cancelled")  # finished: no risk, no open work

Row = dict[str, Any]

_TODAY_SQL = "SELECT CURRENT_DATE AS today"

_PROJECT_HEALTH_SQL = """
WITH params AS (
    SELECT %(today)s::date AS today, %(slip_points)s::numeric AS slip_points
),
counts AS (
    SELECT d.project_id,
           count(*) AS total,
           count(*) FILTER (WHERE d.status = 'done') AS done,
           count(*) FILTER (WHERE d.status <> 'done' AND d.due_date < pr.today) AS overdue,
           count(*) FILTER (WHERE d.status = 'blocked') AS blocked
    FROM deliverables d
    CROSS JOIN params pr
    GROUP BY d.project_id
),
facts AS (
    SELECT p.id, p.name, p.department, p.status, p.start_date, p.end_date,
           pr.today, pr.slip_points,
           p.end_date - pr.today AS days_to_deadline,
           COALESCE(c.total, 0) AS deliverables_total,
           COALESCE(c.done, 0) AS deliverables_done,
           COALESCE(c.overdue, 0) AS deliverables_overdue,
           COALESCE(c.blocked, 0) AS deliverables_blocked,
           round(100.0 * c.done / NULLIF(c.total, 0), 1) AS percent_done,
           round(CASE WHEN pr.today >= p.end_date THEN 100
                      WHEN pr.today <= p.start_date THEN 0
                      ELSE 100.0 * (pr.today - p.start_date) / (p.end_date - p.start_date)
                 END, 1) AS time_elapsed_pct,
           CASE WHEN c.done > 0 THEN p.start_date
                + ceil(GREATEST(pr.today - p.start_date, 0)::numeric * c.total / c.done)::int
           END AS forecast_end_date
    FROM projects p
    CROSS JOIN params pr
    LEFT JOIN counts c ON c.project_id = p.id
    WHERE p.status <> ALL (%(closed)s::text[])
),
flags AS (
    SELECT f.*,
           f.end_date < f.today AS deadline_passed,
           f.percent_done IS NOT NULL
               AND f.time_elapsed_pct - f.percent_done > f.slip_points AS behind_schedule
    FROM facts f
),
health AS (
    SELECT fl.*,
           CASE WHEN fl.deadline_passed THEN 'overdue'
                WHEN fl.deliverables_overdue > 0 OR fl.deliverables_blocked > 0
                     OR fl.behind_schedule THEN 'at_risk'
                ELSE 'on_track'
           END AS health
    FROM flags fl
)
SELECT * FROM health
WHERE NOT %(only_at_risk)s OR health <> 'on_track'
ORDER BY CASE health WHEN 'overdue' THEN 0 WHEN 'at_risk' THEN 1 ELSE 2 END,
         days_to_deadline, name, id
"""

_ACTIVE_PROJECTS_SQL = "SELECT count(*) AS n FROM projects WHERE status = 'active'"

_ALLOCATION_SQL = """
SELECT r.id AS resource_id, r.full_name, r.capacity_pct,
       a.project_id, p.name AS project_name, sum(a.allocation_pct) AS allocation_pct
FROM resources r
LEFT JOIN allocations a
       ON a.resource_id = r.id AND a.start_date <= %(day)s AND a.end_date >= %(day)s
LEFT JOIN projects p ON p.id = a.project_id
WHERE r.is_active OR a.id IS NOT NULL
GROUP BY r.id, a.project_id, p.name
ORDER BY r.full_name, r.id, p.name
"""

_DELIVERABLE_PROGRESS_SQL = """
WITH params AS (SELECT %(today)s::date AS today)
SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
       count(d.id) AS total,
       count(d.id) FILTER (WHERE d.status = 'not_started') AS not_started,
       count(d.id) FILTER (WHERE d.status = 'in_progress') AS in_progress,
       count(d.id) FILTER (WHERE d.status = 'blocked') AS blocked,
       count(d.id) FILTER (WHERE d.status = 'done') AS done,
       round(100.0 * count(d.id) FILTER (WHERE d.status = 'done')
             / NULLIF(count(d.id), 0), 1) AS percent_done,
       count(d.id) FILTER (WHERE d.status <> 'done' AND d.due_date < pr.today) AS overdue,
       nx.id AS next_id, nx.title AS next_title, nx.status AS next_status,
       nx.due_date AS next_due_date
FROM projects p
CROSS JOIN params pr
LEFT JOIN deliverables d ON d.project_id = p.id
LEFT JOIN LATERAL (
    SELECT n.id, n.title, n.status, n.due_date
    FROM deliverables n
    WHERE n.project_id = p.id AND n.status <> 'done' AND n.due_date >= pr.today
    ORDER BY n.due_date, n.id
    LIMIT 1
) nx ON true
WHERE p.status <> ALL (%(closed)s::text[])
GROUP BY p.id, nx.id, nx.title, nx.status, nx.due_date
ORDER BY overdue DESC, p.name, p.id
"""

_OVER_ALLOCATED_SQL = """
WITH params AS (
    SELECT %(window_from)s::date AS window_from, %(window_to)s::date AS window_to
),
-- A person's total only rises where an allocation starts, so the peak in the window is at
-- the window start (allocations already running) or at an allocation start inside it.
checkpoints AS (
    SELECT DISTINCT a.resource_id, GREATEST(a.start_date, pr.window_from) AS day
    FROM allocations a
    CROSS JOIN params pr
    WHERE a.start_date <= pr.window_to AND a.end_date >= pr.window_from
),
loads AS (
    SELECT c.resource_id, c.day, sum(a.allocation_pct) AS total_pct,
           max(a.start_date) AS overlap_start, min(a.end_date) AS overlap_end
    FROM checkpoints c
    JOIN allocations a ON a.resource_id = c.resource_id
                      AND a.start_date <= c.day AND a.end_date >= c.day
    GROUP BY c.resource_id, c.day
),
peaks AS (
    SELECT DISTINCT ON (l.resource_id) l.*, r.full_name, r.capacity_pct
    FROM loads l
    JOIN resources r ON r.id = l.resource_id
    WHERE l.total_pct > r.capacity_pct
    ORDER BY l.resource_id, l.total_pct DESC, l.day
)
SELECT pk.resource_id, pk.full_name, pk.capacity_pct, pk.total_pct AS peak_pct,
       pk.day AS peak_on, pk.overlap_start, pk.overlap_end, pj.projects
FROM peaks pk
CROSS JOIN LATERAL (
    SELECT json_agg(json_build_object('project_id', x.project_id, 'project_name', x.name,
                                      'allocation_pct', x.pct) ORDER BY x.name) AS projects
    FROM (
        SELECT a.project_id, p.name, sum(a.allocation_pct) AS pct
        FROM allocations a
        JOIN projects p ON p.id = a.project_id
        WHERE a.resource_id = pk.resource_id
          AND a.start_date <= pk.day AND a.end_date >= pk.day
        GROUP BY a.project_id, p.name
    ) x
) pj
ORDER BY pk.total_pct DESC, pk.full_name, pk.resource_id
"""

_PROJECT_SQL = "SELECT id, name FROM projects WHERE id = %s"

_DEPENDENCY_CHAIN_SQL = """
WITH RECURSIVE project_deliverables AS (
    SELECT id, title, status, due_date FROM deliverables WHERE project_id = %(project_id)s
),
-- Walk upstream from every deliverable. A step never revisits a node already on its path,
-- so the walk ends even if bad data contains a cycle.
walk (start_id, node_id, depth, path) AS (
    SELECT pd.id, pd.id, 0, ARRAY[pd.id]
    FROM project_deliverables pd
    UNION ALL
    SELECT w.start_id, dd.depends_on_id, w.depth + 1, w.path || dd.depends_on_id
    FROM walk w
    JOIN deliverable_dependencies dd ON dd.deliverable_id = w.node_id
    JOIN project_deliverables up ON up.id = dd.depends_on_id
    WHERE dd.depends_on_id <> ALL (w.path)
),
per_item AS (
    SELECT w.start_id AS id, max(w.depth) AS depth,
           COALESCE(array_agg(DISTINCT w.node_id ORDER BY w.node_id)
                    FILTER (WHERE w.node_id <> w.start_id), '{}') AS upstream_ids,
           COALESCE(bool_or(n.status = 'blocked' AND w.node_id <> w.start_id), false)
               AS blocked_by_upstream
    FROM walk w
    JOIN project_deliverables n ON n.id = w.node_id
    GROUP BY w.start_id
),
-- The longest upstream path ending at each deliverable, listed from it back to its root.
deepest AS (
    SELECT DISTINCT ON (w.start_id) w.start_id AS id, w.path
    FROM walk w
    ORDER BY w.start_id, w.depth DESC, w.path
)
SELECT pd.id, pd.title, pd.status, pd.due_date, pi.depth, pi.upstream_ids,
       pi.blocked_by_upstream, dp.path AS chain_to_root,
       COALESCE((SELECT array_agg(dd.depends_on_id ORDER BY dd.depends_on_id)
                 FROM deliverable_dependencies dd
                 JOIN project_deliverables up ON up.id = dd.depends_on_id
                 WHERE dd.deliverable_id = pd.id), '{}') AS depends_on_ids
FROM project_deliverables pd
JOIN per_item pi ON pi.id = pd.id
JOIN deepest dp ON dp.id = pd.id
ORDER BY pi.depth, pd.due_date, pd.id
"""

_BUDGET_SQL = """
WITH params AS (SELECT %(today)s::date AS today),
spend AS (
    SELECT project_id, sum(amount) AS spent FROM budget_entries GROUP BY project_id
),
figures AS (
    SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
           p.budget_planned AS planned, COALESCE(s.spent, 0) AS spent,
           round(100 * COALESCE(s.spent, 0) / NULLIF(p.budget_planned, 0), 1) AS percent_used,
           round(CASE WHEN pr.today >= p.end_date THEN 100
                      WHEN pr.today <= p.start_date THEN 0
                      ELSE 100.0 * (pr.today - p.start_date) / (p.end_date - p.start_date)
                 END, 1) AS time_elapsed_pct
    FROM projects p
    CROSS JOIN params pr
    LEFT JOIN spend s ON s.project_id = p.id
)
SELECT f.*,
       f.planned - f.spent AS remaining,
       f.spent > f.planned AS over_budget,
       f.percent_used - f.time_elapsed_pct AS burn_gap_pts
FROM figures f
ORDER BY f.percent_used DESC NULLS LAST, f.project_name, f.project_id
"""


def today(conn: psycopg.Connection) -> date:
    """The database's current date: the "today" every insight is judged on."""
    return conn.execute(_TODAY_SQL).fetchone()["today"]


def project_health(
    conn: psycopg.Connection, today: date, *, only_at_risk: bool = False
) -> list[Row]:
    """Health of every open project (status not completed or cancelled), worst first.

    Business rule:
    - A deliverable is overdue when it is not done and its due date is before today.
    - Time elapsed is 100% on or after the deadline, else 0% up to the start date, else
      (today - start) / (deadline - start); a one-day project never divides by zero.
    - A project is behind schedule when time elapsed exceeds deliverables done by more than
      SLIP_POINTS points, both rounded to one decimal place as shown to users. A project
      without deliverables has no done share (0/0), so it is never behind schedule.
    - Health is ``overdue`` when the deadline has passed, else ``at_risk`` when a
      deliverable is overdue or blocked or the project is behind schedule, else
      ``on_track``. A project is at risk when its health is not ``on_track``.
    - The linear forecast end date is start + days elapsed x total / done, rounded up to a
      whole day; it is null until at least one deliverable is done.

    Args:
        conn: Database connection.
        today: The day to judge on.
        only_at_risk: True returns only projects whose health is not ``on_track``.

    Returns:
        One row per project with its facts, the flags ``deadline_passed`` and
        ``behind_schedule``, ``health`` and ``forecast_end_date``.
    """
    params = {
        "today": today,
        "slip_points": SLIP_POINTS,
        "closed": list(CLOSED_PROJECT_STATUSES),
        "only_at_risk": only_at_risk,
    }
    return conn.execute(_PROJECT_HEALTH_SQL, params).fetchall()


def active_project_count(conn: psycopg.Connection) -> int:
    """Projects whose status is ``active`` (the Projects list filtered by status=active)."""
    return conn.execute(_ACTIVE_PROJECTS_SQL).fetchone()["n"]


def allocation_on(conn: psycopg.Connection, day: date) -> list[Row]:
    """Who is allocated to which project on ``day``, one row per person and project.

    Business rule: an allocation counts on every day from its start date to its end date,
    both included, whatever the project's status; two allocations of one person to one
    project add up. Every active person gets a row, with null project fields when nothing
    covers that day, so free capacity shows; an inactive person appears only while
    allocated.
    """
    return conn.execute(_ALLOCATION_SQL, {"day": day}).fetchall()


def deliverable_progress(conn: psycopg.Connection, today: date) -> list[Row]:
    """Deliverable counts per open project, most overdue first.

    Business rule: counts by status, percent done (done / total, null without
    deliverables), overdue (not done and due before today), and the next due item: the
    unfinished deliverable with the earliest due date on or after today. Overdue items are
    counted, never offered as "next".
    """
    params = {"today": today, "closed": list(CLOSED_PROJECT_STATUSES)}
    return conn.execute(_DELIVERABLE_PROGRESS_SQL, params).fetchall()


def over_allocated(conn: psycopg.Connection, window_from: date, window_to: date) -> list[Row]:
    """People booked above their capacity on any day of the window, highest peak first.

    Business rule: a person is over-allocated when the sum of their allocations covering a
    day exceeds their ``capacity_pct``; exactly at capacity is fine. The total only rises
    where an allocation starts, so it is evaluated at the window start and at every
    allocation start date inside the window. The peak is the highest such total (the
    earliest day on a tie). ``overlap_start``/``overlap_end`` is the period in which every
    allocation active at the peak overlaps, so it may begin before the window. ``projects``
    lists those allocations by project.
    """
    params = {"window_from": window_from, "window_to": window_to}
    return conn.execute(_OVER_ALLOCATED_SQL, params).fetchall()


def find_project(conn: psycopg.Connection, project_id: int) -> Row | None:
    """The project's id and name, or None when it does not exist."""
    return conn.execute(_PROJECT_SQL, (project_id,)).fetchone()


def dependency_chain(conn: psycopg.Connection, project_id: int) -> list[Row]:
    """Every deliverable of a project with its place in the dependency chain.

    Business rule: ``depth`` is the number of links on the longest path from a deliverable
    that depends on nothing (depth 0). ``upstream_ids`` are all deliverables it depends on,
    directly or through others; ``depends_on_ids`` only the direct ones. It is
    ``blocked_by_upstream`` when any upstream deliverable is blocked. ``chain_to_root`` is
    its longest upstream path, from itself back to the root. Only links inside the project
    are followed, and a walk never revisits a deliverable already on its path, so it ends
    even if bad data contains a cycle.
    """
    return conn.execute(_DEPENDENCY_CHAIN_SQL, {"project_id": project_id}).fetchall()


def budget_burn(conn: psycopg.Connection, today: date) -> list[Row]:
    """Planned against spent for every project, highest share used first.

    Business rule: spent is the sum of the project's budget entries, remaining is planned
    minus spent, and over budget means spent exceeds planned (so any spend without a
    planned budget is over). Percent used is spent / planned, null when nothing is
    planned. Burn against time compares it with time elapsed (as in project_health):
    ``burn_gap_pts`` = percent used - time elapsed %, positive when money goes faster than
    the calendar. Closed projects stay in, because money spent stays spent.
    """
    return conn.execute(_BUDGET_SQL, {"today": today}).fetchall()
