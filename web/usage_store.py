#!/usr/bin/env python3
"""SQLite store for YatTerra usage metering (核时 / 卡时).

One writer (the ``usage_meter`` daemon) + read-only readers (the web API).
Mirrors ``fleet_monitor.Store``: WAL, lazy ``CREATE TABLE IF NOT EXISTS``,
retention prune, and read-only URI connections for queries.  stdlib only, so
the web app can import it cheaply.

Buckets are stored **from source** (``INSERT ... SELECT SUM(...) ON CONFLICT DO
UPDATE``) rather than accumulated incrementally, so replaying a tick can never
double-count and an interrupted rollup self-heals on the next tick.

Units (all "seconds" are core-seconds / card-seconds / byte-seconds):
    cpu_core_seconds          actual CPU, from cgroup ``usage_usec``
    cpu_req_core_seconds      requested CPU (requests), requests × dt
    mem_gib_seconds           working-set memory, GiB × dt
    gpu_mem_gib_seconds       GPU VRAM in use, GiB × dt
    gpu_compute_card_seconds  SM utilisation integral, card × dt
    storage_home_gib_seconds  group home dir, GiB × dt
    storage_minio_gib_seconds MinIO bucket, GiB × dt
    storage_quota_gib_seconds declared quota, GiB × dt
Core-hours / card-hours are derived at read time (÷3600), never stored.
"""
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

try:
    import siteconf
    _DEFAULT_DB = siteconf.path("usage_meter.db")
except Exception:  # importable without the platform env
    _DEFAULT_DB = "/srv/yatterra/usage_meter.db"

RETENTION_RAW = 48 * 3600            # keep raw rows 48h (intraday charts)
RETENTION_HOURLY = 400 * 86400       # hourly rollups 400d
RETENTION_DAILY = 5 * 365 * 86400    # daily rollups 5y
HOUR = 3600
DAY = 86400

# integrated columns shared by all three tables (in this order)
_INT_COLS = (
    "cpu_core_seconds",
    "cpu_req_core_seconds",
    "mem_gib_seconds",
    "gpu_mem_gib_seconds",
    "gpu_compute_card_seconds",
    "storage_home_gib_seconds",
    "storage_minio_gib_seconds",
    "storage_quota_gib_seconds",
)

# New integrated columns added after v1 shipped.  ``CREATE TABLE IF NOT EXISTS``
# will NOT add them to an existing DB, so ``initialize()`` ALTERs them in
# idempotently (see _migrate).  Keep this list append-only.
_MIGRATE_COLS = (
    ("storage_home_gib_seconds", "REAL NOT NULL DEFAULT 0"),
    ("storage_minio_gib_seconds", "REAL NOT NULL DEFAULT 0"),
    ("storage_quota_gib_seconds", "REAL NOT NULL DEFAULT 0"),
)

_DDL_SAMPLES = """CREATE TABLE IF NOT EXISTS usage_samples (
    group_name TEXT NOT NULL,
    ts REAL NOT NULL,
    dt REAL NOT NULL DEFAULT 0,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib REAL NOT NULL DEFAULT 0,
    mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_mib REAL NOT NULL DEFAULT 0,
    gpu_util_sum REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    storage_home_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_minio_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_quota_gib_seconds REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, ts))"""

_DDL_HOURLY = """CREATE TABLE IF NOT EXISTS usage_hourly (
    group_name TEXT NOT NULL,
    hour_start INTEGER NOT NULL,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    storage_home_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_minio_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_quota_gib_seconds REAL NOT NULL DEFAULT 0,
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, hour_start))"""

_DDL_DAILY = """CREATE TABLE IF NOT EXISTS usage_daily (
    group_name TEXT NOT NULL,
    day_start INTEGER NOT NULL,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    storage_home_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_minio_gib_seconds REAL NOT NULL DEFAULT 0,
    storage_quota_gib_seconds REAL NOT NULL DEFAULT 0,
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, day_start))"""


def db_path():
    """Resolve the DB path (env override wins)."""
    return os.environ.get("YATTERRA_USAGE_DB") or _DEFAULT_DB


def hour_of(ts):
    return int(ts // HOUR) * HOUR


def day_of(ts):
    return int(ts // DAY) * DAY


class UsageStore:
    def __init__(self, path=None):
        self.path = str(path or db_path())

    def initialize(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=15)) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=15000")
            db.execute(_DDL_SAMPLES)
            db.execute("CREATE INDEX IF NOT EXISTS usage_samples_ts ON usage_samples(ts)")
            db.execute(_DDL_HOURLY)
            db.execute("CREATE INDEX IF NOT EXISTS usage_hourly_hour ON usage_hourly(hour_start)")
            db.execute(_DDL_DAILY)
            self._migrate(db)

    @staticmethod
    def _migrate(db):
        """Add post-v1 integrated columns to pre-existing tables.

        ``CREATE TABLE IF NOT EXISTS`` is a no-op on the live DB, so a column
        added to the DDL after first deploy must be ALTERed in explicitly.
        Idempotent: checks ``PRAGMA table_info`` first.
        """
        for table in ("usage_samples", "usage_hourly", "usage_daily"):
            have = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
            for col, ddl in _MIGRATE_COLS:
                if col not in have:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")

    # ── write path (single writer) ───────────────────────────────
    def write_tick(self, rows, now, prev_ts=None):
        """Insert one tick's raw rows, refresh the touched hourly/daily buckets.

        ``rows`` is a list of dicts with keys group_name, ts, dt and the sample
        columns.  Hourly buckets for ``now`` and ``prev_ts`` are recomputed from
        source; the daily buckets for the same two days are recomputed from the
        hourly table.  Idempotent: same (group, ts) / (group, hour) replays are
        absorbed by INSERT OR REPLACE / ON CONFLICT DO UPDATE.
        """
        if not rows:
            return
        with closing(sqlite3.connect(self.path, timeout=15)) as db, db:
            db.execute("PRAGMA busy_timeout=15000")
            db.executemany(
                """INSERT OR REPLACE INTO usage_samples
                   (group_name, ts, dt, cpu_core_seconds, cpu_req_core_seconds,
                    mem_gib, mem_gib_seconds, gpu_mem_mib, gpu_util_sum,
                    gpu_mem_gib_seconds, gpu_compute_card_seconds,
                    storage_home_gib_seconds, storage_minio_gib_seconds,
                    storage_quota_gib_seconds)
                   VALUES (:group_name, :ts, :dt, :cpu_core_seconds,
                           :cpu_req_core_seconds, :mem_gib, :mem_gib_seconds,
                           :gpu_mem_mib, :gpu_util_sum, :gpu_mem_gib_seconds,
                           :gpu_compute_card_seconds,
                           :storage_home_gib_seconds, :storage_minio_gib_seconds,
                           :storage_quota_gib_seconds)""",
                rows,
            )
            buckets = {hour_of(now)} | ({hour_of(prev_ts)} if prev_ts else set())
            for h in buckets:
                self._rollup_hour(db, h, now)
            days = {day_of(now)} | ({day_of(prev_ts)} if prev_ts else set())
            for d in days:
                self._rollup_day(db, d, now)
            self._prune(db, now)

    def _rollup_hour(self, db, hour_start, now):
        db.execute(
            """INSERT INTO usage_hourly
               (group_name, hour_start, cpu_core_seconds, cpu_req_core_seconds,
                mem_gib_seconds, gpu_mem_gib_seconds, gpu_compute_card_seconds,
                storage_home_gib_seconds, storage_minio_gib_seconds,
                storage_quota_gib_seconds, n_samples, updated_at)
               SELECT group_name, ?, SUM(cpu_core_seconds), SUM(cpu_req_core_seconds),
                      SUM(mem_gib_seconds), SUM(gpu_mem_gib_seconds),
                      SUM(gpu_compute_card_seconds), SUM(storage_home_gib_seconds),
                      SUM(storage_minio_gib_seconds), SUM(storage_quota_gib_seconds),
                      COUNT(*), ?
               FROM usage_samples WHERE ts >= ? AND ts < ?
               GROUP BY group_name
               ON CONFLICT(group_name, hour_start) DO UPDATE SET
                 cpu_core_seconds=excluded.cpu_core_seconds,
                 cpu_req_core_seconds=excluded.cpu_req_core_seconds,
                 mem_gib_seconds=excluded.mem_gib_seconds,
                 gpu_mem_gib_seconds=excluded.gpu_mem_gib_seconds,
                 gpu_compute_card_seconds=excluded.gpu_compute_card_seconds,
                 storage_home_gib_seconds=excluded.storage_home_gib_seconds,
                 storage_minio_gib_seconds=excluded.storage_minio_gib_seconds,
                 storage_quota_gib_seconds=excluded.storage_quota_gib_seconds,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (hour_start, now, hour_start, hour_start + HOUR),
        )

    def _rollup_day(self, db, day_start, now):
        db.execute(
            """INSERT INTO usage_daily
               (group_name, day_start, cpu_core_seconds, cpu_req_core_seconds,
                mem_gib_seconds, gpu_mem_gib_seconds, gpu_compute_card_seconds,
                storage_home_gib_seconds, storage_minio_gib_seconds,
                storage_quota_gib_seconds, n_samples, updated_at)
               SELECT group_name, ?, SUM(cpu_core_seconds), SUM(cpu_req_core_seconds),
                      SUM(mem_gib_seconds), SUM(gpu_mem_gib_seconds),
                      SUM(gpu_compute_card_seconds), SUM(storage_home_gib_seconds),
                      SUM(storage_minio_gib_seconds), SUM(storage_quota_gib_seconds),
                      SUM(n_samples), ?
               FROM usage_hourly WHERE hour_start >= ? AND hour_start < ?
               GROUP BY group_name
               ON CONFLICT(group_name, day_start) DO UPDATE SET
                 cpu_core_seconds=excluded.cpu_core_seconds,
                 cpu_req_core_seconds=excluded.cpu_req_core_seconds,
                 mem_gib_seconds=excluded.mem_gib_seconds,
                 gpu_mem_gib_seconds=excluded.gpu_mem_gib_seconds,
                 gpu_compute_card_seconds=excluded.gpu_compute_card_seconds,
                 storage_home_gib_seconds=excluded.storage_home_gib_seconds,
                 storage_minio_gib_seconds=excluded.storage_minio_gib_seconds,
                 storage_quota_gib_seconds=excluded.storage_quota_gib_seconds,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (day_start, now, day_start, day_start + DAY),
        )

    def _prune(self, db, now):
        db.execute("DELETE FROM usage_samples WHERE ts < ?", (now - RETENTION_RAW,))
        db.execute("DELETE FROM usage_hourly WHERE hour_start < ?", (now - RETENTION_HOURLY,))
        db.execute("DELETE FROM usage_daily WHERE day_start < ?", (now - RETENTION_DAILY,))

    # ── read path (read-only connections) ────────────────────────
    def _read(self, query, args):
        if not Path(self.path).exists():
            return []
        uri = Path(self.path).resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(query, args)]

    def series(self, group, since, until, bucket="hour"):
        """Per-bucket rows for one group over [since, until).

        Returns the stored integrated columns plus derived core-hours/card-hours
        and the current-bucket ``partial`` flag is left to the API layer.
        """
        table, tcol = ("usage_hourly", "hour_start") if bucket == "hour" else ("usage_daily", "day_start")
        cols = ", ".join(_INT_COLS)
        rows = self._read(
            f"""SELECT {tcol} AS bucket_start, {cols}, n_samples
                FROM {table} WHERE group_name = ? AND {tcol} >= ? AND {tcol} < ?
                ORDER BY {tcol}""",
            (group, int(since), int(until)),
        )
        return [_derive(r) for r in rows]

    def summary(self, since, until, bucket="hour"):
        """Platform-wide per-bucket totals + per-group rollup over [since, until)."""
        table, tcol = ("usage_hourly", "hour_start") if bucket == "hour" else ("usage_daily", "day_start")
        cols = ", ".join(_INT_COLS)
        series = self._read(
            f"""SELECT {tcol} AS bucket_start, SUM(cpu_core_seconds) AS cpu_core_seconds,
                       SUM(cpu_req_core_seconds) AS cpu_req_core_seconds,
                       SUM(mem_gib_seconds) AS mem_gib_seconds,
                       SUM(gpu_mem_gib_seconds) AS gpu_mem_gib_seconds,
                       SUM(gpu_compute_card_seconds) AS gpu_compute_card_seconds,
                       SUM(storage_home_gib_seconds) AS storage_home_gib_seconds,
                       SUM(storage_minio_gib_seconds) AS storage_minio_gib_seconds,
                       SUM(storage_quota_gib_seconds) AS storage_quota_gib_seconds,
                       SUM(n_samples) AS n_samples
                FROM {table} WHERE {tcol} >= ? AND {tcol} < ?
                GROUP BY {tcol} ORDER BY {tcol}""",
            (int(since), int(until)),
        )
        per_group = self._read(
            f"""SELECT group_name, SUM(cpu_core_seconds) AS cpu_core_seconds,
                       SUM(cpu_req_core_seconds) AS cpu_req_core_seconds,
                       SUM(mem_gib_seconds) AS mem_gib_seconds,
                       SUM(gpu_mem_gib_seconds) AS gpu_mem_gib_seconds,
                       SUM(gpu_compute_card_seconds) AS gpu_compute_card_seconds,
                       SUM(storage_home_gib_seconds) AS storage_home_gib_seconds,
                       SUM(storage_minio_gib_seconds) AS storage_minio_gib_seconds,
                       SUM(storage_quota_gib_seconds) AS storage_quota_gib_seconds,
                       SUM(n_samples) AS n_samples
                FROM {table} WHERE {tcol} >= ? AND {tcol} < ?
                GROUP BY group_name ORDER BY cpu_core_seconds DESC""",
            (int(since), int(until)),
        )
        return [_derive(r) for r in series], [_derive_compact(r) for r in per_group]


def _base(d):
    """Integrated columns → core-hours / GiB-hours / card-hours."""
    return {
        "cpu_core_seconds": round(d.get("cpu_core_seconds") or 0, 3),
        "cpu_req_core_seconds": round(d.get("cpu_req_core_seconds") or 0, 3),
        "mem_gib_seconds": round(d.get("mem_gib_seconds") or 0, 3),
        "gpu_mem_gib_seconds": round(d.get("gpu_mem_gib_seconds") or 0, 3),
        "gpu_compute_card_seconds": round(d.get("gpu_compute_card_seconds") or 0, 3),
        "storage_home_gib_seconds": round(d.get("storage_home_gib_seconds") or 0, 3),
        "storage_minio_gib_seconds": round(d.get("storage_minio_gib_seconds") or 0, 3),
        "storage_quota_gib_seconds": round(d.get("storage_quota_gib_seconds") or 0, 3),
        "core_hours": round((d.get("cpu_core_seconds") or 0) / 3600, 4),
        "request_core_hours": round((d.get("cpu_req_core_seconds") or 0) / 3600, 4),
        "mem_gib_hours": round((d.get("mem_gib_seconds") or 0) / 3600, 4),
        "gpu_mem_gib_hours": round((d.get("gpu_mem_gib_seconds") or 0) / 3600, 4),
        "compute_card_hours": round((d.get("gpu_compute_card_seconds") or 0) / 3600, 4),
        "storage_home_gib_hours": round((d.get("storage_home_gib_seconds") or 0) / 3600, 4),
        "storage_minio_gib_hours": round((d.get("storage_minio_gib_seconds") or 0) / 3600, 4),
        "storage_quota_gib_hours": round((d.get("storage_quota_gib_seconds") or 0) / 3600, 4),
    }


def _derive(d):
    out = {"bucket_start": d.get("bucket_start"), "n_samples": d.get("n_samples") or 0}
    out.update(_base(d))
    req = out["cpu_req_core_seconds"]
    out["cpu_utilization"] = round(out["cpu_core_seconds"] / req, 4) if req > 0 else None
    return out


def _derive_compact(d):
    out = {"group_name": d.get("group_name"), "n_samples": d.get("n_samples") or 0}
    out.update(_base(d))
    out["gap_core_hours"] = round(out["request_core_hours"] - out["core_hours"], 4)
    req = out["cpu_req_core_seconds"]
    out["cpu_utilization"] = round(out["cpu_core_seconds"] / req, 4) if req > 0 else None
    return out
