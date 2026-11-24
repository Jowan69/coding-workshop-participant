"""Connection reuse, the reconnect-and-retry path and the schema bootstrap."""

from __future__ import annotations

import psycopg
import pytest

from acme.core import db


@pytest.mark.no_rollback
def test_retry_reconnects_once_after_operational_error(database) -> None:
    connections = []

    def work(conn: psycopg.Connection) -> int:
        connections.append(conn)
        if len(connections) == 1:
            raise psycopg.OperationalError("server closed the connection unexpectedly")
        return conn.execute("SELECT 1 AS one").fetchone()["one"]

    assert db.run_with_retry(database.SETTINGS, work) == 1
    assert len(connections) == 2
    assert connections[0].closed
    assert connections[1] is db.get_connection(database.SETTINGS)


@pytest.mark.no_rollback
def test_second_operational_error_propagates(database) -> None:
    calls = []

    def work(conn: psycopg.Connection) -> None:
        calls.append(conn)
        raise psycopg.OperationalError("still paused")

    with pytest.raises(psycopg.OperationalError):
        db.run_with_retry(database.SETTINGS, work)
    assert len(calls) == 2


def test_other_errors_are_not_retried(database) -> None:
    calls = []

    def work(conn: psycopg.Connection) -> None:
        calls.append(conn)
        raise ValueError("not a connection problem")

    with pytest.raises(ValueError):
        db.run_with_retry(database.SETTINGS, work)
    assert len(calls) == 1


def test_connection_is_reused(database) -> None:
    assert db.get_connection(database.SETTINGS) is db.get_connection(database.SETTINGS)


def test_ssl_required_outside_local(monkeypatch, database) -> None:
    captured = {}
    monkeypatch.setattr(psycopg, "connect", lambda **kwargs: captured.update(kwargs))
    cloud = database.SETTINGS.__class__(**{**database.SETTINGS.__dict__, "is_local": False})
    db.connect(cloud)
    assert captured["sslmode"] == "require"
    assert captured["connect_timeout"] == 15
    db.connect(database.SETTINGS)
    assert captured["sslmode"] == "prefer"


def test_reset_survives_a_failing_close(monkeypatch, caplog) -> None:
    class Broken:
        def close(self) -> None:
            raise psycopg.InterfaceError("already gone")

    real = db._conn
    monkeypatch.setattr(db, "_conn", Broken())
    db.reset_connection()
    assert db._conn is None
    assert "could not close" in caplog.text
    monkeypatch.setattr(db, "_conn", real)


def test_ensure_schema_fast_path_applies_nothing(monkeypatch, database) -> None:
    def fail(*args, **kwargs):
        raise AssertionError("schema should already be current")

    monkeypatch.setattr(db, "_schema_ready", False)
    monkeypatch.setattr(db, "_apply_schema", fail)
    db.ensure_schema(database.SETTINGS)
    assert db._schema_ready is True


def test_ensure_schema_does_nothing_once_ready(monkeypatch, database) -> None:
    monkeypatch.setattr(db, "get_connection", lambda settings: pytest.fail("no query expected"))
    db.ensure_schema(database.SETTINGS)


def test_ensure_schema_reapplies_a_changed_schema(monkeypatch, conn, database) -> None:
    before = conn.execute("SELECT count(*) AS n FROM projects").fetchone()["n"]
    conn.execute("UPDATE schema_meta SET checksum = 'stale'")
    monkeypatch.setattr(db, "_schema_ready", False)
    db.ensure_schema(database.SETTINGS)
    stored = conn.execute("SELECT checksum FROM schema_meta").fetchone()["checksum"]
    assert stored == db.schema_checksum()
    assert conn.execute("SELECT count(*) AS n FROM projects").fetchone()["n"] == before


def test_checksum_read_inside_a_transaction_tolerates_a_missing_table(conn) -> None:
    conn.execute("ALTER TABLE schema_meta RENAME TO schema_meta_hidden")
    assert db._stored_checksum_in_transaction(conn) is None
    assert conn.execute("SELECT 1 AS ok").fetchone()["ok"] == 1


def test_apply_skips_when_another_container_finished_first(monkeypatch, conn, database) -> None:
    monkeypatch.setattr(db.seed, "run", lambda *a: pytest.fail("seed should not run"))
    db._apply_schema(conn, database.SETTINGS, db.schema_checksum())
