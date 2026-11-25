"""The schema is additive: it applies over the previous version's schema and data, twice.

The cloud database already holds an earlier schema and its rows. These tests build that
state in a scratch database from git (the schema and the seed as they were at an earlier
commit, the *baseline*), then apply today's ``schema.sql`` over it twice and run today's
seed.

The baseline is chosen so that it is always the version *before* the one under test:

- ``schema.sql`` or ``seed.py`` in the working tree differs from ``HEAD`` (the change is
  not committed yet, staged or not): the baseline is ``HEAD``.
- The working tree matches ``HEAD`` (the change is committed, as in CI): the baseline is
  ``HEAD^``. Should ``HEAD^`` hold the same two files as ``HEAD`` (the last commit touched
  neither, so there is nothing to migrate between them), the baseline is the nearest
  earlier commit where either file differs.

Both files are always read from that one commit. The second case needs the history, so
the workflow checks the repository out with ``fetch-depth: 0``; a checkout too shallow to
hold the baseline fails these tests, it does not skip them.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import subprocess  # noqa: S404 - runs fixed git commands, test-only
import types
from pathlib import Path

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

from acme import seed as current_seed
from acme.core import db
from conftest import PG_PASSWORD, ROOT

SCRATCH_DB = "acme_migration_test"
SCHEMA_IN_GIT = "backend/tracker/acme/schema.sql"
SEED_IN_GIT = "backend/tracker/acme/seed.py"
MIGRATED_FILES = (SCHEMA_IN_GIT, SEED_IN_GIT)
TABLES = ("users", "resources", "projects", "deliverables", "deliverable_dependencies",
          "allocations", "budget_entries")
CHILD_TABLES = ("deliverables", "allocations", "budget_entries")
OLDEST_ID = 1000  # the tests below plant projects with explicit ids, above the seed's own
DUPLICATE_ID = 5000  # the newer case variant: older rows can already hold "name (5000)"


# ---------------------------------------------------------------------------------------
# Which commit holds the previous schema and seed
# ---------------------------------------------------------------------------------------


class NoBaseline(Exception):
    """This checkout cannot say what the previous schema and seed were."""


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    """Run one git command in ``root`` and return it, whatever its exit code."""
    return subprocess.run(  # noqa: S603, S607 - fixed arguments, no shell
        ["git", *args], cwd=root, capture_output=True, text=True, check=False, timeout=60,
    )


def _is_git_checkout(root: Path) -> bool:
    """False for a copy of the source without git (an archive), or where git is missing."""
    try:
        return _git(root, "rev-parse", "--is-inside-work-tree").returncode == 0
    except OSError:
        return False


def _files_differ(root: Path, *revisions: str) -> bool:
    """Whether ``schema.sql`` or ``seed.py`` differs.

    With one revision: between it and the working tree (so a change counts whether it is
    staged or not). With two: between those two commits.
    """
    result = _git(root, "diff", "--quiet", *revisions, "--", *MIGRATED_FILES)
    if result.returncode not in (0, 1):  # 0: the same, 1: different, anything else: an error
        raise NoBaseline(
            f"git cannot compare {' and '.join(revisions)}: {result.stderr.strip()}. The "
            "migration tests take the previous schema from an earlier commit, which a "
            "shallow clone does not hold: check out with the history (fetch-depth: 0)."
        )
    return result.returncode == 1


def select_baseline(root: Path) -> str:
    """The git revision that holds the schema and the seed to migrate *from*.

    ``HEAD`` while the working tree's ``schema.sql`` or ``seed.py`` differs from it. Once
    they match (the change is committed), ``HEAD`` is the new schema, so the baseline is
    ``HEAD^``, or the nearest commit before it where either file differs: a commit that
    touched neither file has nothing to migrate from its parent.
    """
    if _files_differ(root, "HEAD"):
        return "HEAD"
    baseline = "HEAD^"
    while not _files_differ(root, baseline, "HEAD"):
        baseline += "^"
    return baseline


def _show(root: Path, revision: str, path: str) -> str:
    """One file as it was at ``revision``."""
    result = _git(root, "show", f"{revision}:{path}")
    if result.returncode != 0:
        raise NoBaseline(f"git show {revision}:{path} failed: {result.stderr.strip()}")
    return result.stdout


@functools.cache
def _baseline(root: Path = ROOT) -> str:
    """This repository's baseline, chosen once per run and used for both files.

    Skips only where the source is not a git checkout at all. In a checkout, a baseline
    that cannot be found (a shallow clone) is a failure: a skip would hide the tests in CI.
    """
    if not _is_git_checkout(root):
        pytest.skip("not a git checkout, so there is no previous schema to migrate from")
    try:
        return select_baseline(root)
    except NoBaseline as exc:
        pytest.fail(str(exc))


def _git_show(path: str) -> str:
    """The file as it was at the baseline commit (see the module docstring)."""
    try:
        return _show(ROOT, _baseline(), path)
    except NoBaseline as exc:
        pytest.fail(str(exc))


def _connect(dbname: str) -> psycopg.Connection:
    return psycopg.connect(
        host="localhost", port=5432, user="postgres", password=PG_PASSWORD, dbname=dbname,
        autocommit=True, row_factory=dict_row,
    )


@pytest.fixture
def scratch() -> psycopg.Connection:
    """An empty scratch database, dropped afterwards."""
    with _connect("postgres") as admin:
        admin.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(SCRATCH_DB)))
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(SCRATCH_DB)))
    connection = _connect(SCRATCH_DB)
    try:
        yield connection
    finally:
        connection.close()
        with _connect("postgres") as admin:
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(SCRATCH_DB)))


def _committed_seed() -> types.ModuleType:
    """The seed module of the baseline commit, the same commit the old schema comes from."""
    module = types.ModuleType("committed_seed")
    exec(compile(_git_show(SEED_IN_GIT), SEED_IN_GIT, "exec"), module.__dict__)  # noqa: S102
    return module


def _counts(conn: psycopg.Connection) -> dict[str, int]:
    return {
        table: conn.execute(
            sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier(table))
        ).fetchone()["n"]
        for table in TABLES
    }


def _columns(conn: psycopg.Connection, table: str) -> set[str]:
    rows = conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s", (table,)
    ).fetchall()
    return {row["column_name"] for row in rows}


def test_the_new_schema_applies_twice_over_the_committed_schema_and_its_data(
    scratch, database
) -> None:
    """The committed schema is the baseline's: HEAD before the commit, HEAD^ after it."""
    settings = database.SETTINGS
    with scratch.transaction():
        scratch.execute(_git_show(SCHEMA_IN_GIT))
        _committed_seed().run(scratch, settings)
    before = _counts(scratch)
    assert before["users"] == 4 and before["projects"] >= 6

    new_schema = Path(db.SCHEMA_PATH).read_text(encoding="utf-8")
    for _ in range(2):
        with scratch.transaction():
            scratch.execute(new_schema)
            current_seed.run(scratch, settings)

    assert _counts(scratch) == before
    assert {"token_version", "must_change_password"} <= _columns(scratch, "users")
    assert _columns(scratch, "login_attempts") >= {"email", "attempted_at"}
    users = scratch.execute(
        "SELECT token_version, must_change_password FROM users ORDER BY id"
    ).fetchall()
    assert all(user["must_change_password"] is False for user in users)


def test_the_new_schema_applies_twice_to_an_empty_database(scratch, database) -> None:
    new_schema = Path(db.SCHEMA_PATH).read_text(encoding="utf-8")
    for _ in range(2):
        with scratch.transaction():
            scratch.execute(new_schema)
            current_seed.run(scratch, database.SETTINGS)
    counts = _counts(scratch)
    assert counts["users"] == 4 and counts["projects"] == 6


def _names(conn: psycopg.Connection) -> dict[int, str]:
    rows = conn.execute("SELECT id, name FROM projects ORDER BY id").fetchall()
    return {row["id"]: row["name"] for row in rows}


def test_case_variant_project_names_are_renamed_before_the_unique_index(scratch, database) -> None:
    """E5: the deployed database may hold "Apollo" and "APOLLO"; the migration must cope."""
    with scratch.transaction():
        scratch.execute(_git_show(SCHEMA_IN_GIT))
        _committed_seed().run(scratch, database.SETTINGS)
        long_name = "L" * 150
        for name in ("Apollo", "APOLLO", "apollo", "Customer portal revamp", long_name,
                     long_name.lower(), "Unique Name"):
            scratch.execute(
                "INSERT INTO projects (name, department, start_date, end_date) "
                "VALUES (%s, 'Test', '2026-01-01', '2026-02-01')",
                (name,),
            )
    before = _names(scratch)
    ids = {name: project_id for project_id, name in before.items()}

    new_schema = Path(db.SCHEMA_PATH).read_text(encoding="utf-8")
    for _ in range(2):
        with scratch.transaction():
            scratch.execute(new_schema)
            current_seed.run(scratch, database.SETTINGS)

    after = _names(scratch)
    assert len(after) == len(before)
    # the oldest of each set keeps its name; the newer ones get their id appended
    assert after[ids["Apollo"]] == "Apollo"
    assert after[ids["APOLLO"]] == f"APOLLO ({ids['APOLLO']})"
    assert after[ids["apollo"]] == f"apollo ({ids['apollo']})"
    assert after[ids["Customer Portal Revamp"]] == "Customer Portal Revamp"
    renamed_portal = ids["Customer portal revamp"]
    assert after[renamed_portal] == f"Customer portal revamp ({renamed_portal})"
    assert after[ids["Unique Name"]] == "Unique Name"
    # a name already at the 150-character limit is shortened to make room for the id
    shortened = after[ids["l" * 150]]
    assert len(shortened) == 150
    assert shortened.endswith(f" ({ids['l' * 150]})") and shortened.startswith("lll")
    assert len({name.lower() for name in after.values()}) == len(after)
    index = scratch.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'projects_name_lower_key'"
    ).fetchone()
    assert index is not None and "UNIQUE" in index["indexdef"] and "lower" in index["indexdef"]


def _plant(conn: psycopg.Connection, project_id: int, name: str) -> None:
    """Insert a project under a chosen id, so a test decides which rows are older."""
    conn.execute(
        "INSERT INTO projects (id, name, department, start_date, end_date) "
        "OVERRIDING SYSTEM VALUE VALUES (%s, %s, 'Test', '2026-01-01', '2026-02-01')",
        (project_id, name),
    )


def _attach_children(conn: psycopg.Connection, project_id: int) -> None:
    """Give a project one deliverable, one allocation and one budget entry."""
    resource_id = conn.execute("SELECT min(id) AS id FROM resources").fetchone()["id"]
    conn.execute(
        "INSERT INTO deliverables (project_id, title, due_date) VALUES (%s, 'Kept', '2026-01-15')",
        (project_id,),
    )
    conn.execute(
        "INSERT INTO allocations (resource_id, project_id, allocation_pct, start_date, end_date) "
        "VALUES (%s, %s, 10, '2026-01-01', '2026-02-01')",
        (resource_id, project_id),
    )
    conn.execute(
        "INSERT INTO budget_entries (project_id, category, amount, spent_on) "
        "VALUES (%s, 'other', 1, '2026-01-10')",
        (project_id,),
    )


def _project_rows(conn: psycopg.Connection) -> dict[int, dict]:
    rows = conn.execute("SELECT * FROM projects ORDER BY id").fetchall()
    return {row["id"]: row for row in rows}


def _children(conn: psycopg.Connection) -> dict[str, list[tuple[int, int]]]:
    """Which project every deliverable, allocation and budget entry belongs to."""
    query = sql.SQL("SELECT id, project_id FROM {} ORDER BY id")
    return {
        table: [
            (row["id"], row["project_id"])
            for row in conn.execute(query.format(sql.Identifier(table))).fetchall()
        ]
        for table in CHILD_TABLES
    }


def _committed_database(scratch: psycopg.Connection, settings: object) -> None:
    """The deployed state: the schema and the seed of the baseline commit."""
    scratch.execute(_git_show(SCHEMA_IN_GIT))
    _committed_seed().run(scratch, settings)


def _migrate_twice_and_check(scratch: psycopg.Connection, settings: object) -> dict[int, str]:
    """Apply today's schema and seed twice and check what must hold whatever the names were.

    Returns the final name of every project by id.
    """
    before = _project_rows(scratch)
    counts, children = _counts(scratch), _children(scratch)

    new_schema = Path(db.SCHEMA_PATH).read_text(encoding="utf-8")
    applications = []
    for _ in range(2):
        with scratch.transaction():
            scratch.execute(new_schema)
            current_seed.run(scratch, settings)
        applications.append(_project_rows(scratch))
    after, after_second = applications

    # idempotent: the second application renames nothing and touches no project row
    assert after_second == after
    # no row is deleted, and every child row still belongs to the same project
    assert after.keys() == before.keys()
    assert _counts(scratch) == counts
    assert _children(scratch) == children

    older_names: set[str] = set()
    for project_id, row in before.items():  # ascending id: oldest first
        renamed = after[project_id]
        if row["name"].lower() not in older_names:
            # the oldest of its name, or no duplicate at all: the row is untouched
            assert renamed == row
        else:
            # a newer duplicate: its own id is appended to (the start of) its old name
            suffix = re.search(rf" \({project_id}(-[1-9][0-9]*)?\)$", renamed["name"])
            assert suffix is not None, renamed["name"]
            assert row["name"].startswith(renamed["name"][: suffix.start()])
            changed = {key for key in row if row[key] != renamed[key]}
            assert changed == {"name", "updated_at"}
        older_names.add(row["name"].lower())

    # judged by the database: unique whatever the case, and within the column's 150 characters
    summary = scratch.execute(
        "SELECT count(*) AS projects, count(DISTINCT lower(name)) AS names, "
        "max(length(name)) AS longest FROM projects"
    ).fetchone()
    assert summary["names"] == summary["projects"] == len(before)
    assert summary["longest"] <= 150
    index = scratch.execute(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'projects_name_lower_key'"
    ).fetchone()
    assert index is not None and "UNIQUE" in index["indexdef"] and "lower" in index["indexdef"]
    return {project_id: row["name"] for project_id, row in after.items()}


def test_a_chain_of_taken_generated_names_longer_than_five_steps_is_resolved(
    scratch, database
) -> None:
    """The names the rename would give "APOLLO" are taken, nine candidates deep.

    Two chains are planted. "apollo (5000)", "apollo (5000) (5000)" and so on, six deep, is
    the one the earlier migration walked: it renamed five times, gave up, and the unique
    index then failed. "(5000)", "(5000-2)" up to "(5000-9)" are the first nine candidates
    of the present one, so it settles on its tenth, well past the old limit of five.
    """
    repeated_suffix = [f"apollo{f' ({DUPLICATE_ID})' * depth}" for depth in range(1, 7)]
    numbered_suffix = [f"aPoLLo ({DUPLICATE_ID}-{attempt})" for attempt in range(2, 10)]
    older, newer = repeated_suffix + numbered_suffix[:4], numbered_suffix[4:]
    blockers = {
        **{OLDEST_ID + offset: name for offset, name in enumerate(older, start=1)},
        **{DUPLICATE_ID + offset: name for offset, name in enumerate(newer, start=1)},
    }
    with scratch.transaction():
        _committed_database(scratch, database.SETTINGS)
        _plant(scratch, OLDEST_ID, "Apollo")
        _plant(scratch, DUPLICATE_ID, "APOLLO")
        for project_id, name in blockers.items():
            _plant(scratch, project_id, name)
        _attach_children(scratch, DUPLICATE_ID)

    names = _migrate_twice_and_check(scratch, database.SETTINGS)

    assert names[OLDEST_ID] == "Apollo"
    assert names[DUPLICATE_ID] == f"APOLLO ({DUPLICATE_ID}-10)"
    # the projects that already held the generated names keep them, older and newer alike
    assert {project_id: names[project_id] for project_id in blockers} == blockers
    owned = [project for rows in _children(scratch).values() for _, project in rows]
    assert owned.count(DUPLICATE_ID) == 3


def test_a_generated_name_another_project_holds_is_skipped_not_taken(scratch, database) -> None:
    """A project already called "MERCURY (5000)", in that very case, keeps its name.

    The earlier migration stopped here with a unique violation on projects_name_key, and
    renamed the project newer than the duplicate although it never was one.
    """
    with scratch.transaction():
        _committed_database(scratch, database.SETTINGS)
        _plant(scratch, OLDEST_ID, "Mercury")
        _plant(scratch, OLDEST_ID + 1, f"MERCURY ({DUPLICATE_ID})")
        _plant(scratch, DUPLICATE_ID, "MERCURY")
        _plant(scratch, DUPLICATE_ID + 1, f"mercury ({DUPLICATE_ID}-2)")

    names = _migrate_twice_and_check(scratch, database.SETTINGS)

    assert names[OLDEST_ID] == "Mercury"
    assert names[OLDEST_ID + 1] == f"MERCURY ({DUPLICATE_ID})"
    assert names[DUPLICATE_ID] == f"MERCURY ({DUPLICATE_ID}-3)"
    assert names[DUPLICATE_ID + 1] == f"mercury ({DUPLICATE_ID}-2)"


def test_a_long_name_stays_within_150_characters_through_a_collision_chain(
    scratch, database
) -> None:
    """Each candidate is cut to fit its own suffix, and the cut candidates can be taken too."""
    first = "N" * 143 + f" ({DUPLICATE_ID})"
    second = "N" * 141 + f" ({DUPLICATE_ID}-2)"
    assert len(first) == len(second) == 150
    with scratch.transaction():
        _committed_database(scratch, database.SETTINGS)
        _plant(scratch, OLDEST_ID, "N" * 150)
        _plant(scratch, OLDEST_ID + 1, first)
        _plant(scratch, DUPLICATE_ID, "n" * 150)
        _plant(scratch, DUPLICATE_ID + 1, second)

    names = _migrate_twice_and_check(scratch, database.SETTINGS)

    assert names[OLDEST_ID] == "N" * 150
    assert names[OLDEST_ID + 1] == first and names[DUPLICATE_ID + 1] == second
    assert names[DUPLICATE_ID] == "n" * 141 + f" ({DUPLICATE_ID}-3)"
    assert len(names[DUPLICATE_ID]) == 150


def test_duplicates_whose_generated_names_meet_each_other_all_end_up_distinct(
    scratch, database
) -> None:
    """Two sets of case variants, where one set's names are the other's generated names."""
    zeta, zeta_upper, zeta_lower = OLDEST_ID, DUPLICATE_ID, DUPLICATE_ID + 1
    suffixed, suffixed_upper = OLDEST_ID + 1, DUPLICATE_ID + 2
    with scratch.transaction():
        _committed_database(scratch, database.SETTINGS)
        _plant(scratch, zeta, "Zeta")
        _plant(scratch, zeta_upper, "ZETA")
        _plant(scratch, zeta_lower, "zeta")
        # "zeta (5001)" is what the third project would be renamed to: here two others,
        # themselves case variants of each other, already hold it
        _plant(scratch, suffixed, f"Zeta ({zeta_lower})")
        _plant(scratch, suffixed_upper, f"ZETA ({zeta_lower})")

    names = _migrate_twice_and_check(scratch, database.SETTINGS)

    assert names == {
        **{project_id: name for project_id, name in names.items() if project_id < OLDEST_ID},
        zeta: "Zeta",
        suffixed: f"Zeta ({zeta_lower})",
        zeta_upper: f"ZETA ({zeta_upper})",
        zeta_lower: f"zeta ({zeta_lower}-2)",
        suffixed_upper: f"ZETA ({zeta_lower}) ({suffixed_upper})",
    }


# ---------------------------------------------------------------------------------------
# The baseline selection itself, on throwaway repositories
# ---------------------------------------------------------------------------------------

# Commits need an identity (a CI runner has none) and must not sign or run the user's hooks
COMMIT_OPTIONS = ("-c", "user.name=Migration Test", "-c", "user.email=migration@acme.test",
                  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null")
SCHEMA_V1, SCHEMA_V2 = "-- schema, phase 5\n", "-- schema, phase 5\n-- schema, phase 6\n"
SEED_V1, SEED_V2 = "# seed, phase 5\n", "# seed, phase 5\n# seed, phase 6\n"


def _run_git(root: Path, *args: str) -> None:
    result = _git(root, *args)
    assert result.returncode == 0, result.stderr


def _write(root: Path, files: dict[str, str]) -> None:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _commit(root: Path, message: str, files: dict[str, str]) -> None:
    _write(root, files)
    _run_git(root, "add", "--all")
    _run_git(root, *COMMIT_OPTIONS, "commit", "--quiet", "-m", message)


def _baseline_files(root: Path) -> tuple[str, str, str]:
    """The selected revision, and the schema and the seed read from it."""
    revision = select_baseline(root)
    return revision, _show(root, revision, SCHEMA_IN_GIT), _show(root, revision, SEED_IN_GIT)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository of two commits: phase 5, then phase 6 changing the schema and the seed."""
    if shutil.which("git") is None:
        pytest.skip("git is not installed")
    root = tmp_path / "repo"
    root.mkdir()
    _run_git(root, "init", "--quiet")
    _commit(root, "phase 5", {SCHEMA_IN_GIT: SCHEMA_V1, SEED_IN_GIT: SEED_V1, "README.md": "1\n"})
    _commit(root, "phase 6", {SCHEMA_IN_GIT: SCHEMA_V2, SEED_IN_GIT: SEED_V2})
    return root


def test_an_uncommitted_schema_change_migrates_from_head(repo) -> None:
    """Dirty tree: HEAD still holds the previous schema, as it does before a phase's commit."""
    _write(repo, {SCHEMA_IN_GIT: SCHEMA_V2 + "-- schema, phase 7\n"})

    assert _baseline_files(repo) == ("HEAD", SCHEMA_V2, SEED_V2)


def test_a_staged_schema_change_migrates_from_head(repo) -> None:
    """Dirty tree: staging a change does not commit it, so HEAD is still the baseline."""
    _write(repo, {SCHEMA_IN_GIT: SCHEMA_V2 + "-- schema, phase 7\n"})
    _run_git(repo, "add", SCHEMA_IN_GIT)

    assert _baseline_files(repo) == ("HEAD", SCHEMA_V2, SEED_V2)


def test_a_change_to_the_seed_alone_takes_both_files_from_head(repo) -> None:
    """One revision for both files: the untouched schema is not read from an older commit."""
    _write(repo, {SEED_IN_GIT: SEED_V2 + "# seed, phase 7\n"})

    assert _baseline_files(repo) == ("HEAD", SCHEMA_V2, SEED_V2)


def test_a_clean_tree_migrates_from_the_commit_before_head(repo) -> None:
    """Clean tree: HEAD is the schema under test, so the previous one is at HEAD^.

    This is the state CI sees. Reading HEAD here would apply the new schema over itself.
    """
    assert _baseline_files(repo) == ("HEAD^", SCHEMA_V1, SEED_V1)


def test_only_the_schema_and_the_seed_decide_whether_the_tree_is_clean(repo) -> None:
    """Other edits, untracked files and a rewritten but identical file leave it clean."""
    _write(repo, {"README.md": "edited\n", "notes.txt": "untracked\n", SCHEMA_IN_GIT: SCHEMA_V2})
    later = (repo / SCHEMA_IN_GIT).stat().st_mtime + 60
    os.utime(repo / SCHEMA_IN_GIT, (later, later))  # a new timestamp, the same content
    _run_git(repo, "add", "README.md")

    assert _baseline_files(repo) == ("HEAD^", SCHEMA_V1, SEED_V1)


def test_a_commit_that_changed_only_the_seed_takes_both_files_from_its_parent(repo) -> None:
    """One revision for both files, in a clean tree too: the schema comes from HEAD^ as well."""
    seed_v3 = SEED_V2 + "# seed, phase 7\n"
    _commit(repo, "phase 7", {SEED_IN_GIT: seed_v3})

    assert _baseline_files(repo) == ("HEAD^", SCHEMA_V2, SEED_V2)


def test_a_commit_that_left_both_files_alone_is_stepped_over(repo) -> None:
    """A later commit of documentation must not turn the test into new-over-new.

    HEAD^ then holds the same schema and seed as HEAD, so the baseline is the commit
    before the last one that changed them. An uncommitted change still migrates from HEAD.
    """
    _commit(repo, "docs", {"README.md": "2\n"})
    _commit(repo, "more docs", {"README.md": "3\n"})

    assert _baseline_files(repo) == ("HEAD^^^", SCHEMA_V1, SEED_V1)

    _write(repo, {SCHEMA_IN_GIT: SCHEMA_V2 + "-- schema, phase 7\n"})
    assert _baseline_files(repo) == ("HEAD", SCHEMA_V2, SEED_V2)


def test_a_shallow_clone_fails_the_clean_tree_case_instead_of_skipping_it(repo, tmp_path) -> None:
    """actions/checkout fetches one commit by default: HEAD^ is not there.

    The selection says so, naming the fix, and the tests that use it fail. Only a copy of
    the source that is not a git checkout at all skips.
    """
    shallow = tmp_path / "shallow"
    _run_git(tmp_path, "clone", "--quiet", "--depth", "1", repo.as_uri(), str(shallow))

    with pytest.raises(NoBaseline, match=r"HEAD\^.*fetch-depth: 0"):
        select_baseline(shallow)
    with pytest.raises(pytest.fail.Exception, match="fetch-depth: 0"):
        _baseline(shallow)

    # one commit is enough while the change is uncommitted
    _write(shallow, {SCHEMA_IN_GIT: SCHEMA_V2 + "-- schema, phase 7\n"})
    assert _baseline_files(shallow) == ("HEAD", SCHEMA_V2, SEED_V2)

    archive = tmp_path / "archive"
    _write(archive, {SCHEMA_IN_GIT: SCHEMA_V2, SEED_IN_GIT: SEED_V2})
    with pytest.raises(pytest.skip.Exception, match="not a git checkout"):
        _baseline(archive)


def test_the_baseline_of_this_repository_is_never_the_schema_under_test() -> None:
    """Whatever state this checkout is in, the migration tests start from an older version.

    Before a schema change is committed the baseline is HEAD; afterwards it is an earlier
    commit. In both, what it holds differs from the files the tests apply over it.
    """
    baseline = _baseline()
    assert baseline == "HEAD" or baseline.startswith("HEAD^")
    old = (_git_show(SCHEMA_IN_GIT), _git_show(SEED_IN_GIT))
    new = (
        Path(db.SCHEMA_PATH).read_text(encoding="utf-8"),
        Path(current_seed.__file__).read_text(encoding="utf-8"),
    )
    assert old != new
    # and it is the committed state the selection rule names, not some other revision
    assert (baseline == "HEAD") == _files_differ(ROOT, "HEAD")
