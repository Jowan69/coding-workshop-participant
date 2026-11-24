"""One reused PostgreSQL connection per Lambda container, plus the schema bootstrap."""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import psycopg
from psycopg.rows import dict_row

from acme import seed
from acme.core.config import Settings

logger = logging.getLogger("acme.db")

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"
SCHEMA_LOCK_KEY = 72_430_001  # advisory lock id shared by every container of this app

T = TypeVar("T")

# Survive between invocations of a warm Lambda container
_conn: psycopg.Connection | None = None
_schema_ready = False


def connect(settings: Settings) -> psycopg.Connection:
    """Open an autocommit connection that returns rows as dicts."""
    return psycopg.connect(
        host=settings.db_host,
        port=settings.db_port,
        dbname=settings.db_name,
        user=settings.db_user,
        password=settings.db_pass,
        sslmode="prefer" if settings.is_local else "require",
        connect_timeout=15,
        autocommit=True,
        row_factory=dict_row,
    )


def get_connection(settings: Settings) -> psycopg.Connection:
    """Return the container's connection, opening a new one if it is missing or broken."""
    global _conn
    if _conn is None or _conn.closed or _conn.broken:
        _conn = connect(settings)
    return _conn


def reset_connection() -> None:
    """Close and forget the container's connection so the next call reconnects."""
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except psycopg.Error:
            logger.warning("could not close a broken connection cleanly")
    _conn = None


def run_with_retry(
    settings: Settings, work: Callable[[psycopg.Connection], T], *, transaction: bool = True
) -> T:
    """Run ``work(conn)`` (in one transaction by default), retrying once on OperationalError.

    Aurora Serverless v2 pauses at zero capacity and a warm container's connection can go
    stale, so the first failure reconnects and runs the work again. Any other error, or a
    second OperationalError, propagates.
    """

    def attempt() -> T:
        conn = get_connection(settings)
        if not transaction:
            return work(conn)
        with conn.transaction():
            return work(conn)

    try:
        return attempt()
    except psycopg.OperationalError as exc:
        logger.warning(
            "database unavailable (%s); reconnecting and retrying once", type(exc).__name__
        )
        reset_connection()
    return attempt()


def schema_checksum() -> str:
    """SHA-256 of schema.sql, stored in schema_meta once that schema is applied."""
    return hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()


_CHECKSUM_SQL = "SELECT checksum FROM schema_meta WHERE id = 1"


def _stored_checksum(conn: psycopg.Connection) -> str | None:
    """Read the applied checksum with one autocommit query; None before the first apply."""
    try:
        row = conn.execute(_CHECKSUM_SQL).fetchone()
    except psycopg.errors.UndefinedTable:
        return None
    return row["checksum"] if row else None


def _stored_checksum_in_transaction(conn: psycopg.Connection) -> str | None:
    """Same as _stored_checksum, inside a savepoint so a missing table keeps the transaction."""
    try:
        with conn.transaction():
            row = conn.execute(_CHECKSUM_SQL).fetchone()
    except psycopg.errors.UndefinedTable:
        return None
    return row["checksum"] if row else None


def _apply_schema(conn: psycopg.Connection, settings: Settings, checksum: str) -> None:
    conn.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_LOCK_KEY,))
    if _stored_checksum_in_transaction(conn) == checksum:
        return  # another container applied it while this one waited for the lock
    logger.info("applying schema.sql and seeding empty tables")
    conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    seed.run(conn, settings)
    conn.execute(
        "INSERT INTO schema_meta (id, checksum) VALUES (1, %s) "
        "ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()",
        (checksum,),
    )


def ensure_schema(settings: Settings) -> None:
    """Make sure schema.sql is applied and demo data seeded, at most once per container.

    After the first success a container makes no queries here. A cold start against a
    current database costs one autocommit SELECT. Otherwise the schema is applied and the
    seed run in one transaction under ``pg_advisory_xact_lock``, so concurrent cold
    starts apply it once.
    """
    global _schema_ready
    if _schema_ready:
        return
    checksum = schema_checksum()
    if run_with_retry(settings, _stored_checksum, transaction=False) != checksum:
        run_with_retry(settings, lambda conn: _apply_schema(conn, settings, checksum))
    _schema_ready = True
