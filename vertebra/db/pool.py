"""asyncpg connection pool tailored for Neon serverless Postgres.

Neon fronts Postgres with PgBouncer in transaction mode, so prepared-statement
caching must be disabled and TLS enforced. The pool is created once per process
by the FastAPI lifespan or the worker bootstrap and shared by all tasks.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

import asyncpg

from vertebra.config.settings import DatabaseSettings, Settings, get_settings
from vertebra.db.ast_veto import validate_tenant_query
from vertebra.logging_conf import get_logger

log = get_logger("db.pool")

_MIGRATIONS_PATH = Path(__file__).with_name("migrations.sql")


class Database:
    """Async facade over a Neon Postgres instance."""

    def __init__(self, settings: DatabaseSettings) -> None:
        self._settings = settings
        self._pool: asyncpg.Pool | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ setup
    async def connect(self) -> asyncpg.Pool:
        """Create (or return) the shared connection pool."""
        if self._pool is not None and not self._pool.is_closed():
            return self._pool
        async with self._lock:
            if self._pool is not None and not self._pool.is_closed():
                return self._pool
            log.info(
                "connecting_postgres",
                min_size=self._settings.min_pool_size,
                max_size=self._settings.max_pool_size,
            )
            self._pool = await asyncpg.create_pool(
                dsn=self._settings.asyncpg_dsn,
                min_size=self._settings.min_pool_size,
                max_size=self._settings.max_pool_size,
                command_timeout=self._settings.command_timeout_sec,
                statement_cache_size=self._settings.statement_cache_size,
                # PgBouncer transaction pooling: force simple query protocol.
                max_cached_statement_lifetime=0,
                ssl="require" if "sslmode=disable" not in self._settings.asyncpg_dsn else None,
            )
            log.info("postgres_connected")
        return self._pool

    async def close(self) -> None:
        if self._pool is not None and not self._pool.is_closed():
            await self._pool.close()
            log.info("postgres_closed")
        self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None or self._pool.is_closed():
            raise RuntimeError("Database.connect() must be awaited before use")
        return self._pool

    # ------------------------------------------------------------ migrations
    async def apply_migrations(self, sql_path: Path | None = None) -> None:
        """Apply the schema DDL idempotently (all statements are IF NOT EXISTS)."""
        path = sql_path or _MIGRATIONS_PATH
        sql = path.read_text(encoding="utf-8")
        async with self.pool.acquire() as conn:
            await conn.execute(sql)
        log.info("migrations_applied", path=str(path))

    # ---------------------------------------------------------------- helpers
    async def fetch(self, sql: str, *args: Any, enforce_tenant: bool = False, expected_tenant_id: str | None = None) -> list[asyncpg.Record]:
        if enforce_tenant:
            validate_tenant_query(sql, expected_tenant_id=expected_tenant_id)
        async with self.pool.acquire() as conn:
            return await conn.fetch(sql, *args)

    async def fetchrow(self, sql: str, *args: Any, enforce_tenant: bool = False, expected_tenant_id: str | None = None) -> asyncpg.Record | None:
        if enforce_tenant:
            validate_tenant_query(sql, expected_tenant_id=expected_tenant_id)
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(sql, *args)

    async def execute(self, sql: str, *args: Any, enforce_tenant: bool = False, expected_tenant_id: str | None = None) -> str:
        if enforce_tenant:
            validate_tenant_query(sql, expected_tenant_id=expected_tenant_id)
        async with self.pool.acquire() as conn:
            return await conn.execute(sql, *args)

    async def executemany(self, sql: str, args_seq: Iterable[Sequence[Any]]) -> None:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(sql, list(args_seq))

    async def transaction(self):
        """Expose a connection-bound transaction for outbox writes."""
        conn = await self.pool.acquire()
        tx = conn.transaction()
        await tx.start()
        return _TxHandle(conn, tx)


class _TxHandle:
    """Context manager for an explicit asyncpg transaction on a held connection."""

    def __init__(self, conn: asyncpg.Connection, tx: asyncpg.Transaction) -> None:
        self._conn = conn
        self._tx = tx

    async def __aenter__(self) -> asyncpg.Connection:
        return self._conn

    async def __aexit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                await self._tx.commit()
            else:
                await self._tx.rollback()
        finally:
            await self._conn._pool.release(self._conn)  # noqa: SLF001 - pool backref


def database_from_settings(settings: Settings | None = None) -> Database:
    """Build a Database from the process settings singleton."""
    return Database((settings or get_settings()).database)
