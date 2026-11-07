"""Storage metering: schema migration + the three storage columns flow through.

Covers the two things the storage feature can silently break on:

- **migration** — a v1 DB created *without* the storage columns must gain them
  (``CREATE TABLE IF NOT EXISTS`` is a no-op on an existing table), with a
  default of 0 so old rows still read cleanly;
- **rollups** — a tick carrying the three ``storage_*_gib_seconds`` integrals
  must aggregate into ``usage_hourly`` / ``usage_daily`` and surface their
  derived GiB·hours (÷3600) from ``series`` / ``summary``.
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import usage_store

_V1_SAMPLES = """CREATE TABLE IF NOT EXISTS usage_samples (
    group_name TEXT NOT NULL, ts REAL NOT NULL, dt REAL NOT NULL DEFAULT 0,
    cpu_core_seconds REAL NOT NULL DEFAULT 0,
    cpu_req_core_seconds REAL NOT NULL DEFAULT 0,
    mem_gib REAL NOT NULL DEFAULT 0, mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_mem_mib REAL NOT NULL DEFAULT 0, gpu_util_sum REAL NOT NULL DEFAULT 0,
    gpu_mem_gib_seconds REAL NOT NULL DEFAULT 0,
    gpu_compute_card_seconds REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (group_name, ts))"""


def _cols(path, table):
    with sqlite3.connect(path) as db:
        return {r[1] for r in db.execute(f"PRAGMA table_info({table})")}


class StorageMigration(unittest.TestCase):
    def test_v1_db_gains_storage_columns_with_zero_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "old.db")
            with sqlite3.connect(path) as db:
                db.execute(_V1_SAMPLES)
                db.execute(
                    "INSERT INTO usage_samples (group_name, ts, cpu_core_seconds) "
                    "VALUES ('g', 1, 5)"
                )
            usage_store.UsageStore(path).initialize()
            for table in ("usage_samples", "usage_hourly", "usage_daily"):
                cols = _cols(path, table)
                for col in (
                    "storage_home_gib_seconds",
                    "storage_minio_gib_seconds",
                    "storage_quota_gib_seconds",
                ):
                    self.assertIn(col, cols, f"{table}.{col} missing")
            # pre-existing row reads back as 0, not NULL
            got = usage_store.UsageStore(path).series("g", 0, 10, "hour")
            self.assertEqual(got, [])  # not rolled up, just prove no crash
            with sqlite3.connect(path) as db:
                v = db.execute(
                    "SELECT storage_home_gib_seconds FROM usage_samples "
                    "WHERE group_name='g'"
                ).fetchone()[0]
            self.assertEqual(v, 0)

    def test_initialize_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "u.db")
            usage_store.UsageStore(path).initialize()
            usage_store.UsageStore(path).initialize()  # second call must not raise
            self.assertIn("storage_home_gib_seconds", _cols(path, "usage_samples"))


class StorageRollups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = usage_store.UsageStore(str(Path(self.tmp.name) / "u.db"))
        self.store.initialize()
        self.now = 1_700_000_000
        self.store.write_tick([self._row(self.now, 30.0)], self.now, None)

    @staticmethod
    def _row(ts, dt):
        return {
            "group_name": "g1", "ts": ts, "dt": dt,
            "cpu_core_seconds": 0, "cpu_req_core_seconds": 0,
            "mem_gib": 2.0, "mem_gib_seconds": 2.0 * dt,
            "gpu_mem_mib": 0, "gpu_util_sum": 0,
            "gpu_mem_gib_seconds": 0, "gpu_compute_card_seconds": 0,
            "storage_home_gib_seconds": 3.0 * dt,
            "storage_minio_gib_seconds": 1.0 * dt,
            "storage_quota_gib_seconds": 5.0 * dt,
        }

    def test_hourly_and_daily_carry_storage(self):
        h = self.store.series("g1", self.now - 200_000, self.now + 200_000, "hour")[0]
        d = self.store.series("g1", self.now - 200_000, self.now + 200_000, "day")[0]
        for row in (h, d):
            self.assertAlmostEqual(row["storage_home_gib_hours"], 0.025, places=4)
            self.assertAlmostEqual(row["storage_minio_gib_hours"], 1.0 / 120, places=4)
            self.assertAlmostEqual(row["storage_quota_gib_hours"], 5.0 / 120, places=4)
            self.assertAlmostEqual(row["mem_gib_hours"], 2.0 / 120, places=4)

    def test_summary_exposes_storage(self):
        series, per_group = self.store.summary(self.now - 200_000, self.now + 200_000, "hour")
        self.assertAlmostEqual(series[0]["storage_home_gib_hours"], 0.025, places=4)
        self.assertAlmostEqual(per_group[0]["storage_minio_gib_hours"], 1.0 / 120, places=4)

    def test_replay_does_not_double_count(self):
        # same (group, ts) rewritten → raw row replaced, rollups recomputed
        self.store.write_tick([self._row(self.now, 30.0)], self.now, None)
        h = self.store.series("g1", self.now - 200_000, self.now + 200_000, "hour")[0]
        self.assertAlmostEqual(h["storage_home_gib_hours"], 0.025, places=4)
        self.assertEqual(h["n_samples"], 1)


if __name__ == "__main__":
    unittest.main()
