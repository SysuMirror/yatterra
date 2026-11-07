#!/usr/bin/env python3
"""SQLite store for YatTerra time-series *features* (the forecast substrate).

One writer (the ``feat_loop`` daemon) + read-only readers (the web API and
``forecast.py``).  Mirrors ``usage_store``: WAL, lazy ``CREATE TABLE IF NOT
EXISTS``, retention prune, read-only URI connections, and buckets stored **from
source** so a replayed tick can never double-count and an interrupted rollup
self-heals on the next tick.

Deliberately a *separate* DB from ``usage_meter.db``: ``usage_meter`` owns that
file's ``.lock`` and a second writer would break the "single writer per DB"
invariant.  This file has its own ``.lock`` and its own daemon.

Two families of tables:

* **group** — per-group demand/usage features sampled from ``usage_samples``:
  ``feat_samples`` (raw 48h) → ``feat_hourly`` (400d) → ``feat_daily`` (5y).
* **pressure** — host pressure signal sampled from ``pressure.json``:
  ``feat_pressure_samples`` (raw 48h) → ``feat_pressure_hourly`` (400d) →
  ``feat_pressure_daily`` (5y).  Carries ``level_seconds`` — how long each hour
  spent in each hysteretic pressure ``level`` — which is the time-axis primitive
  the valley/peak scheduler needs.

Units: rates are stored per-sample (``cpu_cores`` = core-seconds/``dt``);
hourly/daily carry both the integrals (seconds) and the peak/valley stats.
std-lib only.
"""
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

try:
    import siteconf
    _DEFAULT_DB = siteconf.path("features.db")
except Exception:  # importable without the platform env
    _DEFAULT_DB = "/srv/yatterra/features.db"

RETENTION_RAW = 48 * 3600            # keep raw rows 48h
RETENTION_HOURLY = 400 * 86400       # hourly rollups 400d
RETENTION_DAILY = 5 * 365 * 86400    # daily rollups 5y
HOUR = 3600
DAY = 86400

# pressure dimensions whose level we accumulate `level_seconds` for (the keys of
# pressure_writer's `level` map).
LEVEL_DIMS = ("cpu", "gpu", "gpu_mem", "gpu_temp", "mem", "swap", "psi", "disk", "bw")


def db_path():
    """Resolve the DB path (env override wins)."""
    return os.environ.get("YATTERRA_FEATURE_DB") or _DEFAULT_DB


def hour_of(ts):
    return int(ts // HOUR) * HOUR


def day_of(ts):
    return int(ts // DAY) * DAY


def _bucket_span(bucket):
    return DAY if bucket == "day" else HOUR


_DDL_GROUP_SAMPLES = """CREATE TABLE IF NOT EXISTS feat_samples (
    group_name TEXT NOT NULL,
    ts REAL NOT NULL,
    dt REAL NOT NULL DEFAULT 0,
    cpu_cores REAL NOT NULL DEFAULT 0,
    cpu_req_cores REAL NOT NULL DEFAULT 0,
    mem_gib REAL NOT NULL DEFAULT 0,
    gpu_util REAL NOT NULL DEFAULT 0,
    gpu_mem_mib REAL NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (group_name, ts))"""

_DDL_GROUP_HOURLY = """CREATE TABLE IF NOT EXISTS feat_hourly (
    group_name TEXT NOT NULL,
    hour_start INTEGER NOT NULL,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    cpu_cores_min REAL,
    cpu_cores_avg REAL,
    cpu_cores_max REAL,
    gpu_util_max REAL,
    gpu_mem_mib_max REAL,
    mem_gib_max REAL,
    cpu_utilization REAL,
    gap_core_hours REAL,
    meta TEXT NOT NULL DEFAULT '{}',
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, hour_start))"""

_DDL_GROUP_DAILY = """CREATE TABLE IF NOT EXISTS feat_daily (
    group_name TEXT NOT NULL,
    day_start INTEGER NOT NULL,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    cpu_cores_min REAL,
    cpu_cores_avg REAL,
    cpu_cores_max REAL,
    gpu_util_max REAL,
    gpu_mem_mib_max REAL,
    mem_gib_max REAL,
    cpu_utilization REAL,
    gap_core_hours REAL,
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, day_start))"""

_DDL_PRESSURE_SAMPLES = """CREATE TABLE IF NOT EXISTS feat_pressure_samples (
    ts REAL NOT NULL PRIMARY KEY,
    dt REAL NOT NULL DEFAULT 0,
    cpu_avg REAL, cpu_max REAL,
    gpu_avg REAL, gpu_max REAL,
    gpu_mem_avg REAL, gpu_mem_max REAL,
    mem_avg REAL, mem_max REAL,
    psi_max REAL, psi_cpu_max REAL, psi_mem_max REAL, psi_io_max REAL,
    bw_avg REAL, bw_max REAL, disk_max REAL,
    level_json TEXT NOT NULL DEFAULT '{}')"""

_DDL_PRESSURE_HOURLY = """CREATE TABLE IF NOT EXISTS feat_pressure_hourly (
    hour_start INTEGER NOT NULL PRIMARY KEY,
    cpu_avg REAL, cpu_max REAL,
    gpu_avg REAL, gpu_max REAL,
    gpu_mem_avg REAL, gpu_mem_max REAL,
    mem_avg REAL, mem_max REAL,
    psi_max REAL, bw_avg REAL, bw_max REAL, disk_max REAL,
    level_seconds TEXT NOT NULL DEFAULT '{}',
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0)"""

_DDL_PRESSURE_DAILY = """CREATE TABLE IF NOT EXISTS feat_pressure_daily (
    day_start INTEGER NOT NULL PRIMARY KEY,
    cpu_avg REAL, cpu_max REAL,
    gpu_avg REAL, gpu_max REAL,
    gpu_mem_avg REAL, gpu_mem_max REAL,
    mem_avg REAL, mem_max REAL,
    psi_max REAL, bw_avg REAL, bw_max REAL, disk_max REAL,
    level_seconds TEXT NOT NULL DEFAULT '{}',
    n_samples INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0)"""

# rate/peak columns shared by feat_pressure_hourly & _daily
_P_HOURLY_COLS = ("cpu_avg", "cpu_max", "gpu_avg", "gpu_max", "gpu_mem_avg",
                  "gpu_mem_max", "mem_avg", "mem_max", "psi_max", "bw_avg",
                  "bw_max", "disk_max")

# integral + peak columns shared by feat_hourly & feat_daily
_G_INT_COLS = ("cpu_core_seconds", "cpu_req_core_seconds", "mem_gib_seconds",
               "gpu_mem_gib_seconds", "gpu_compute_card_seconds")
_G_PEAK_COLS = ("cpu_cores_min", "cpu_cores_avg", "cpu_cores_max",
                "gpu_util_max", "gpu_mem_mib_max", "mem_gib_max",
                "cpu_utilization", "gap_core_hours")


def _sum_level_seconds(rows):
    """Fold raw ``(dt, level_json)`` rows into ``{dim: {level: seconds}}``.

    ``level_json`` is the pressure writer's ``level`` map at that sample; each
    sample contributes its ``dt`` to the bucket its level names.
    """
    out = {}
    for dt, lj in rows:
        try:
            levels = json.loads(lj) if lj else {}
        except (TypeError, ValueError):
            continue
        dt = float(dt or 0)
        for dim, lvl in (levels or {}).items():
            if dim not in LEVEL_DIMS or not isinstance(lvl, str):
                continue
            out.setdefault(dim, {}).setdefault(lvl, 0.0)
            out[dim][lvl] += dt
    return {dim: {k: round(v, 3) for k, v in lv.items()} for dim, lv in out.items()}


class FeatureStore:
    def __init__(self, path=None):
        self.path = str(path or db_path())

    def initialize(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=15)) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=15000")
            for ddl in (_DDL_GROUP_SAMPLES, _DDL_GROUP_HOURLY, _DDL_GROUP_DAILY,
                        _DDL_PRESSURE_SAMPLES, _DDL_PRESSURE_HOURLY,
                        _DDL_PRESSURE_DAILY):
                db.execute(ddl)
            db.execute("CREATE INDEX IF NOT EXISTS feat_samples_ts ON feat_samples(ts)")
            db.execute("CREATE INDEX IF NOT EXISTS feat_hourly_hour ON feat_hourly(hour_start)")
            db.execute("CREATE INDEX IF NOT EXISTS feat_pressure_samples_ts ON feat_pressure_samples(ts)")

    # ── write path (single writer) ───────────────────────────────
    def write_tick(self, group_rows, platform_row, now, prev_ts=None):
        """Insert one tick's raw group + pressure rows, refresh touched buckets.

        ``group_rows`` is a list of per-group dicts with keys group_name, ts, dt
        and the rate columns; ``platform_row`` is a single host-pressure dict (or
        None).  Hourly buckets for ``now``/``prev_ts`` are recomputed from source;
        daily buckets are recomputed from the hourly tables.  Idempotent.
        """
        with closing(sqlite3.connect(self.path, timeout=15)) as db, db:
            db.execute("PRAGMA busy_timeout=15000")
            if group_rows:
                rows = [dict({"meta": "{}"}, **r) for r in group_rows]
                db.executemany(
                    """INSERT OR REPLACE INTO feat_samples
                       (group_name, ts, dt, cpu_cores, cpu_req_cores, mem_gib,
                        gpu_util, gpu_mem_mib, meta)
                       VALUES (:group_name, :ts, :dt, :cpu_cores, :cpu_req_cores,
                               :mem_gib, :gpu_util, :gpu_mem_mib, :meta)""",
                    rows)
            if platform_row:
                db.execute(
                    """INSERT OR REPLACE INTO feat_pressure_samples
                       (ts, dt, cpu_avg, cpu_max, gpu_avg, gpu_max, gpu_mem_avg,
                        gpu_mem_max, mem_avg, mem_max, psi_max, psi_cpu_max,
                        psi_mem_max, psi_io_max, bw_avg, bw_max, disk_max,
                        level_json)
                       VALUES (:ts, :dt, :cpu_avg, :cpu_max, :gpu_avg, :gpu_max,
                               :gpu_mem_avg, :gpu_mem_max, :mem_avg, :mem_max,
                               :psi_max, :psi_cpu_max, :psi_mem_max, :psi_io_max,
                               :bw_avg, :bw_max, :disk_max, :level_json)""",
                    platform_row)

            hours = {hour_of(now)} | ({hour_of(prev_ts)} if prev_ts else set())
            for h in hours:
                self._rollup_group_hour(db, h, now)
                self._rollup_pressure_hour(db, h, now)
            days = {day_of(now)} | ({day_of(prev_ts)} if prev_ts else set())
            for d in days:
                self._rollup_group_day(db, d, now)
                self._rollup_pressure_day(db, d, now)
            self._prune(db, now)

    def _rollup_group_hour(self, db, hour_start, now):
        db.execute(
            """INSERT INTO feat_hourly
               (group_name, hour_start, cpu_core_seconds, cpu_req_core_seconds,
                mem_gib_seconds, gpu_mem_gib_seconds, gpu_compute_card_seconds,
                cpu_cores_min, cpu_cores_avg, cpu_cores_max, gpu_util_max,
                gpu_mem_mib_max, mem_gib_max, cpu_utilization, gap_core_hours,
                meta, n_samples, updated_at)
               SELECT group_name, ?,
                      SUM(cpu_cores * dt), SUM(cpu_req_cores * dt),
                      SUM(mem_gib * dt), SUM(gpu_mem_mib / 1024.0 * dt),
                      SUM(gpu_util / 100.0 * dt),
                      MIN(cpu_cores), AVG(cpu_cores), MAX(cpu_cores),
                      MAX(gpu_util), MAX(gpu_mem_mib), MAX(mem_gib),
                      CASE WHEN SUM(cpu_req_cores * dt) > 0
                           THEN SUM(cpu_cores * dt) / SUM(cpu_req_cores * dt)
                           ELSE NULL END,
                      (SUM(cpu_req_cores * dt) - SUM(cpu_cores * dt)) / 3600.0,
                      COALESCE(MAX(meta), '{}'), COUNT(*), ?
               FROM feat_samples WHERE ts >= ? AND ts < ?
               GROUP BY group_name
               ON CONFLICT(group_name, hour_start) DO UPDATE SET
                 cpu_core_seconds=excluded.cpu_core_seconds,
                 cpu_req_core_seconds=excluded.cpu_req_core_seconds,
                 mem_gib_seconds=excluded.mem_gib_seconds,
                 gpu_mem_gib_seconds=excluded.gpu_mem_gib_seconds,
                 gpu_compute_card_seconds=excluded.gpu_compute_card_seconds,
                 cpu_cores_min=excluded.cpu_cores_min,
                 cpu_cores_avg=excluded.cpu_cores_avg,
                 cpu_cores_max=excluded.cpu_cores_max,
                 gpu_util_max=excluded.gpu_util_max,
                 gpu_mem_mib_max=excluded.gpu_mem_mib_max,
                 mem_gib_max=excluded.mem_gib_max,
                 cpu_utilization=excluded.cpu_utilization,
                 gap_core_hours=excluded.gap_core_hours,
                 meta=excluded.meta,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (hour_start, now, hour_start, hour_start + HOUR),
        )

    def _rollup_group_day(self, db, day_start, now):
        db.execute(
            """INSERT INTO feat_daily
               (group_name, day_start, cpu_core_seconds, cpu_req_core_seconds,
                mem_gib_seconds, gpu_mem_gib_seconds, gpu_compute_card_seconds,
                cpu_cores_min, cpu_cores_avg, cpu_cores_max, gpu_util_max,
                gpu_mem_mib_max, mem_gib_max, cpu_utilization, gap_core_hours,
                n_samples, updated_at)
               SELECT group_name, ?,
                      SUM(cpu_core_seconds), SUM(cpu_req_core_seconds),
                      SUM(mem_gib_seconds), SUM(gpu_mem_gib_seconds),
                      SUM(gpu_compute_card_seconds),
                      MIN(cpu_cores_min), AVG(cpu_cores_avg), MAX(cpu_cores_max),
                      MAX(gpu_util_max), MAX(gpu_mem_mib_max), MAX(mem_gib_max),
                      CASE WHEN SUM(cpu_req_core_seconds) > 0
                           THEN SUM(cpu_core_seconds) / SUM(cpu_req_core_seconds)
                           ELSE NULL END,
                      (SUM(cpu_req_core_seconds) - SUM(cpu_core_seconds)) / 3600.0,
                      SUM(n_samples), ?
               FROM feat_hourly WHERE hour_start >= ? AND hour_start < ?
               GROUP BY group_name
               ON CONFLICT(group_name, day_start) DO UPDATE SET
                 cpu_core_seconds=excluded.cpu_core_seconds,
                 cpu_req_core_seconds=excluded.cpu_req_core_seconds,
                 mem_gib_seconds=excluded.mem_gib_seconds,
                 gpu_mem_gib_seconds=excluded.gpu_mem_gib_seconds,
                 gpu_compute_card_seconds=excluded.gpu_compute_card_seconds,
                 cpu_cores_min=excluded.cpu_cores_min,
                 cpu_cores_avg=excluded.cpu_cores_avg,
                 cpu_cores_max=excluded.cpu_cores_max,
                 gpu_util_max=excluded.gpu_util_max,
                 gpu_mem_mib_max=excluded.gpu_mem_mib_max,
                 mem_gib_max=excluded.mem_gib_max,
                 cpu_utilization=excluded.cpu_utilization,
                 gap_core_hours=excluded.gap_core_hours,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (day_start, now, day_start, day_start + DAY),
        )

    def _rollup_pressure_hour(self, db, hour_start, now):
        # level_seconds needs a Python fold (JSON per sample), done from source.
        raw = db.execute(
            "SELECT dt, level_json FROM feat_pressure_samples "
            "WHERE ts >= ? AND ts < ?", (hour_start, hour_start + HOUR)).fetchall()
        level_seconds = json.dumps(_sum_level_seconds(raw), ensure_ascii=False)
        db.execute(
            """INSERT INTO feat_pressure_hourly
               (hour_start, cpu_avg, cpu_max, gpu_avg, gpu_max, gpu_mem_avg,
                gpu_mem_max, mem_avg, mem_max, psi_max, bw_avg, bw_max, disk_max,
                level_seconds, n_samples, updated_at)
               SELECT ?, AVG(cpu_avg), MAX(cpu_max), AVG(gpu_avg), MAX(gpu_max),
                      AVG(gpu_mem_avg), MAX(gpu_mem_max), AVG(mem_avg),
                      MAX(mem_max), MAX(psi_max), AVG(bw_avg), MAX(bw_max),
                      MAX(disk_max), ?, COUNT(*), ?
               FROM feat_pressure_samples WHERE ts >= ? AND ts < ?
               HAVING COUNT(*) > 0
               ON CONFLICT(hour_start) DO UPDATE SET
                 cpu_avg=excluded.cpu_avg, cpu_max=excluded.cpu_max,
                 gpu_avg=excluded.gpu_avg, gpu_max=excluded.gpu_max,
                 gpu_mem_avg=excluded.gpu_mem_avg, gpu_mem_max=excluded.gpu_mem_max,
                 mem_avg=excluded.mem_avg, mem_max=excluded.mem_max,
                 psi_max=excluded.psi_max, bw_avg=excluded.bw_avg,
                 bw_max=excluded.bw_max, disk_max=excluded.disk_max,
                 level_seconds=excluded.level_seconds,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (hour_start, level_seconds, now, hour_start, hour_start + HOUR),
        )

    def _rollup_pressure_day(self, db, day_start, now):
        rows = db.execute(
            "SELECT level_seconds, n_samples FROM feat_pressure_hourly "
            "WHERE hour_start >= ? AND hour_start < ?",
            (day_start, day_start + DAY)).fetchall()
        merged = {}
        for ls, _n in rows:
            try:
                lv = json.loads(ls) if ls else {}
            except (TypeError, ValueError):
                continue
            for dim, per in (lv or {}).items():
                for k, v in per.items():
                    merged.setdefault(dim, {}).setdefault(k, 0.0)
                    merged[dim][k] += float(v)
        level_seconds = json.dumps(
            {d: {k: round(v, 3) for k, v in p.items()} for d, p in merged.items()},
            ensure_ascii=False)
        db.execute(
            """INSERT INTO feat_pressure_daily
               (day_start, cpu_avg, cpu_max, gpu_avg, gpu_max, gpu_mem_avg,
                gpu_mem_max, mem_avg, mem_max, psi_max, bw_avg, bw_max, disk_max,
                level_seconds, n_samples, updated_at)
               SELECT ?, AVG(cpu_avg), MAX(cpu_max), AVG(gpu_avg), MAX(gpu_max),
                      AVG(gpu_mem_avg), MAX(gpu_mem_max), AVG(mem_avg),
                      MAX(mem_max), MAX(psi_max), AVG(bw_avg), MAX(bw_max),
                      MAX(disk_max), ?, SUM(n_samples), ?
               FROM feat_pressure_hourly WHERE hour_start >= ? AND hour_start < ?
               HAVING COUNT(*) > 0
               ON CONFLICT(day_start) DO UPDATE SET
                 cpu_avg=excluded.cpu_avg, cpu_max=excluded.cpu_max,
                 gpu_avg=excluded.gpu_avg, gpu_max=excluded.gpu_max,
                 gpu_mem_avg=excluded.gpu_mem_avg, gpu_mem_max=excluded.gpu_mem_max,
                 mem_avg=excluded.mem_avg, mem_max=excluded.mem_max,
                 psi_max=excluded.psi_max, bw_avg=excluded.bw_avg,
                 bw_max=excluded.bw_max, disk_max=excluded.disk_max,
                 level_seconds=excluded.level_seconds,
                 n_samples=excluded.n_samples, updated_at=excluded.updated_at""",
            (day_start, level_seconds, now, day_start, day_start + DAY),
        )

    def _prune(self, db, now):
        db.execute("DELETE FROM feat_samples WHERE ts < ?", (now - RETENTION_RAW,))
        db.execute("DELETE FROM feat_pressure_samples WHERE ts < ?", (now - RETENTION_RAW,))
        db.execute("DELETE FROM feat_hourly WHERE hour_start < ?", (now - RETENTION_HOURLY,))
        db.execute("DELETE FROM feat_pressure_hourly WHERE hour_start < ?", (now - RETENTION_HOURLY,))
        db.execute("DELETE FROM feat_daily WHERE day_start < ?", (now - RETENTION_DAILY,))
        db.execute("DELETE FROM feat_pressure_daily WHERE day_start < ?", (now - RETENTION_DAILY,))

    # ── read path (read-only connections) ────────────────────────
    def _read(self, query, args):
        if not Path(self.path).exists():
            return []
        uri = Path(self.path).resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(query, args)]

    def series(self, group, since, until, bucket="hour"):
        """Per-bucket feature rows for one group over [since, until).

        ``bucket`` is ``hour`` or ``day``; includes integrals, peak/valley stats
        and derived core-hours / card-hours.
        """
        span = _bucket_span(bucket)
        lo = int(since) // span * span  # include the bucket that covers `since`
        table, tcol = (("feat_hourly", "hour_start") if bucket == "hour"
                       else ("feat_daily", "day_start"))
        cols = ", ".join(_G_INT_COLS + _G_PEAK_COLS)
        rows = self._read(
            f"""SELECT {tcol} AS bucket_start, {cols}, n_samples
                FROM {table} WHERE group_name = ? AND {tcol} >= ? AND {tcol} < ?
                ORDER BY {tcol}""",
            (group, lo, int(until)),
        )
        return [_derive(r) for r in rows]

    def pressure_series(self, since, until, bucket="hour"):
        """Per-bucket host-pressure rows over [since, until), platform-wide."""
        span = _bucket_span(bucket)
        lo = int(since) // span * span
        table, tcol = (("feat_pressure_hourly", "hour_start") if bucket == "hour"
                       else ("feat_pressure_daily", "day_start"))
        cols = ", ".join(_P_HOURLY_COLS)
        return self._read(
            f"""SELECT {tcol} AS bucket_start, {cols}, level_seconds, n_samples
                FROM {table} WHERE {tcol} >= ? AND {tcol} < ? ORDER BY {tcol}""",
            (lo, int(until)),
        )

    def summary(self, since, until, bucket="hour"):
        """Platform-wide per-bucket totals + per-group rollup over [since, until)."""
        span = _bucket_span(bucket)
        lo = int(since) // span * span
        table, tcol = (("feat_hourly", "hour_start") if bucket == "hour"
                       else ("feat_daily", "day_start"))
        cols = ", ".join(_G_INT_COLS)
        series = self._read(
            f"""SELECT {tcol} AS bucket_start, SUM(cpu_core_seconds) AS cpu_core_seconds,
                       SUM(cpu_req_core_seconds) AS cpu_req_core_seconds,
                       SUM(mem_gib_seconds) AS mem_gib_seconds,
                       SUM(gpu_mem_gib_seconds) AS gpu_mem_gib_seconds,
                       SUM(gpu_compute_card_seconds) AS gpu_compute_card_seconds,
                       SUM(n_samples) AS n_samples
                FROM {table} WHERE {tcol} >= ? AND {tcol} < ?
                GROUP BY {tcol} ORDER BY {tcol}""",
            (lo, int(until)),
        )
        per_group = self._read(
            f"""SELECT group_name, SUM(cpu_core_seconds) AS cpu_core_seconds,
                       SUM(cpu_req_core_seconds) AS cpu_req_core_seconds,
                       SUM(mem_gib_seconds) AS mem_gib_seconds,
                       SUM(gpu_mem_gib_seconds) AS gpu_mem_gib_seconds,
                       SUM(gpu_compute_card_seconds) AS gpu_compute_card_seconds,
                       MAX(gpu_util_max) AS gpu_util_max,
                       MAX(cpu_cores_max) AS cpu_cores_max,
                       SUM(n_samples) AS n_samples
                FROM {table} WHERE {tcol} >= ? AND {tcol} < ?
                GROUP BY group_name ORDER BY cpu_core_seconds DESC""",
            (lo, int(until)),
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
        "core_hours": round((d.get("cpu_core_seconds") or 0) / 3600, 4),
        "gpu_mem_gib_hours": round((d.get("gpu_mem_gib_seconds") or 0) / 3600, 4),
        "compute_card_hours": round((d.get("gpu_compute_card_seconds") or 0) / 3600, 4),
    }


def _derive(d):
    out = {"bucket_start": d.get("bucket_start"), "n_samples": d.get("n_samples") or 0}
    out.update(_base(d))
    for c in _G_PEAK_COLS:
        if c in d:
            out[c] = d[c]
    req = out["cpu_req_core_seconds"]
    out["cpu_utilization"] = (round(out["cpu_core_seconds"] / req, 4)
                              if req > 0 else d.get("cpu_utilization"))
    out["gap_core_hours"] = round(
        (out["cpu_req_core_seconds"] - out["cpu_core_seconds"]) / 3600, 4)
    return out


def _derive_compact(d):
    out = {"group_name": d.get("group_name"), "n_samples": d.get("n_samples") or 0}
    out.update(_base(d))
    out["gap_core_hours"] = round(
        (out["cpu_req_core_seconds"] - out["cpu_core_seconds"]) / 3600, 4)
    if "gpu_util_max" in d:
        out["gpu_util_max"] = d["gpu_util_max"]
    if "cpu_cores_max" in d:
        out["cpu_cores_max"] = d["cpu_cores_max"]
    return out
