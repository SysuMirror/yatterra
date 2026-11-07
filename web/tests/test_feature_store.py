"""feature_store: DDL, rollup-from-source idempotency, retention, level_seconds.

Uses a temp DB via the ``path`` constructor arg — never touches
``/opt/yatterra/features.db``.
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import feature_store as fs


def _group(now, dt=30.0, g="g1", cores=2.0, req=4.0, mem=8.0, util=50.0, gmem=4096.0):
    return {"group_name": g, "ts": now, "dt": dt, "cpu_cores": cores,
            "cpu_req_cores": req, "mem_gib": mem, "gpu_util": util,
            "gpu_mem_mib": gmem}


def _platform(now, dt=30.0, level=None):
    return {"ts": now, "dt": dt, "cpu_avg": 0.3, "cpu_max": 0.9,
            "gpu_avg": 0.1, "gpu_max": 0.5, "gpu_mem_avg": 0.2,
            "gpu_mem_max": 0.6, "mem_avg": 0.4, "mem_max": 0.7,
            "psi_max": 3.0, "psi_cpu_max": 2.0, "psi_mem_max": 1.0,
            "psi_io_max": 0.5, "bw_avg": 0.1, "bw_max": 0.2, "disk_max": 0.45,
            "level_json": json.dumps(level or {"cpu": "high", "gpu": "low"})}


class StoreCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "features.db")
        self.store = fs.FeatureStore(self.path)
        self.store.initialize()
        self.now = 1_700_000_000.0
        self.hour = fs.hour_of(self.now)

    def rows(self, table, where=""):
        with sqlite3.connect(self.path) as db:
            db.row_factory = sqlite3.Row
            return [dict(r) for r in db.execute(f"SELECT * FROM {table} {where}")]


class TimeBuckets(unittest.TestCase):
    def test_hour_and_day_are_utc_aligned(self):
        self.assertEqual(fs.hour_of(1_700_000_123.0), 1_700_000_123.0 // 3600 * 3600)
        self.assertEqual(fs.day_of(1_700_000_123.0), 1_700_000_123.0 // 86400 * 86400)
        self.assertEqual(fs.hour_of(0), 0)
        self.assertIn(fs._bucket_span("hour"), (3600,))
        self.assertIn(fs._bucket_span("day"), (86400,))


class Initialize(StoreCase):
    def test_initialize_creates_tables_and_indexes(self):
        names = {r["name"] for r in self.rows("sqlite_master")}
        for t in ("feat_samples", "feat_hourly", "feat_daily",
                  "feat_pressure_samples", "feat_pressure_hourly",
                  "feat_pressure_daily"):
            self.assertIn(t, names)
        idx = {r["name"] for r in self.rows("sqlite_master", "WHERE type='index'")}
        self.assertIn("feat_samples_ts", idx)
        self.assertIn("feat_hourly_hour", idx)


class RollupIdempotent(StoreCase):
    def test_write_tick_rollup_is_idempotent(self):
        g = [_group(self.now)]
        p = _platform(self.now)
        self.store.write_tick(g, p, self.now, self.now - 30)
        first = self.rows("feat_hourly", f"WHERE hour_start={self.hour}")[0]
        # replay the same tick — integrals must not double
        self.store.write_tick(g, p, self.now, self.now - 30)
        second = self.rows("feat_hourly", f"WHERE hour_start={self.hour}")[0]
        self.assertAlmostEqual(first["cpu_core_seconds"], 60.0)
        self.assertAlmostEqual(second["cpu_core_seconds"], 60.0)
        self.assertEqual(first["n_samples"], second["n_samples"], 1)
        self.assertAlmostEqual(first["gpu_compute_card_seconds"], 15.0)
        self.assertAlmostEqual(first["cpu_utilization"], 0.5)

    def test_integrals_accumulate_across_ticks(self):
        self.store.write_tick([_group(self.now, dt=30)], None, self.now, None)
        self.store.write_tick([_group(self.now + 30, dt=30)], None,
                              self.now + 30, self.now)
        h = self.rows("feat_hourly", f"WHERE hour_start={self.hour}")[0]
        self.assertAlmostEqual(h["cpu_core_seconds"], 120.0)
        self.assertEqual(h["n_samples"], 2)
        self.assertAlmostEqual(h["cpu_cores_max"], 2.0)

    def test_daily_is_summed_from_hourly(self):
        self.store.write_tick([_group(self.now)], None, self.now, None)
        self.store.write_tick([_group(self.now + 3600)], None,
                              self.now + 3600, self.now)
        d = self.rows("feat_daily")
        self.assertEqual(len(d), 1)
        self.assertAlmostEqual(d[0]["cpu_core_seconds"], 120.0)
        self.assertEqual(d[0]["n_samples"], 2)


class LevelSeconds(StoreCase):
    def test_level_seconds_accumulate_per_dim(self):
        lvl = {"cpu": "high", "gpu": "low", "bw": "med"}
        self.store.write_tick([], _platform(self.now, 10.0, lvl), self.now, None)
        self.store.write_tick([], _platform(self.now + 10, 20.0, lvl),
                              self.now + 10, self.now)
        h = self.rows("feat_pressure_hourly", f"WHERE hour_start={self.hour}")[0]
        ls = json.loads(h["level_seconds"])
        self.assertAlmostEqual(ls["cpu"]["high"], 30.0)
        self.assertAlmostEqual(ls["gpu"]["low"], 30.0)
        self.assertAlmostEqual(ls["bw"]["med"], 30.0)
        self.assertAlmostEqual(h["cpu_avg"], 0.3)
        self.assertAlmostEqual(h["cpu_max"], 0.9)

    def test_pressure_daily_merges_hourly_level_seconds(self):
        for i, h in enumerate((self.now, self.now + 3600)):
            self.store.write_tick([], _platform(h, 10.0, {"cpu": "med"}), h, None)
        d = self.rows("feat_pressure_daily")[0]
        ls = json.loads(d["level_seconds"])
        self.assertAlmostEqual(ls["cpu"]["med"], 20.0)


class Retention(StoreCase):
    def test_prune_drops_rows_past_retention(self):
        self.store.write_tick([_group(self.now)],
                              _platform(self.now), self.now, None)
        future = self.now + fs.RETENTION_RAW + 100
        self.store.write_tick([], None, future, None)
        self.assertEqual(self.rows("feat_samples"), [])
        self.assertEqual(self.rows("feat_pressure_samples"), [])
        # hourly/daily within 400d/5y survive
        self.assertTrue(self.rows("feat_hourly"))


class ReadPath(StoreCase):
    def test_missing_db_reads_empty_without_throwing(self):
        missing = fs.FeatureStore(os.path.join(os.path.dirname(self.path), "no.db"))
        self.assertEqual(missing.series("g", 0, 10), [])
        self.assertEqual(missing.pressure_series(0, 10), [])
        self.assertEqual(missing.summary(0, 10), ([], []))

    def test_series_aligns_since_down_to_bucket(self):
        self.store.write_tick([_group(self.now)], _platform(self.now),
                              self.now, None)
        # `since` is mid-bucket; the bucket covering it must still be returned
        ser = self.store.series("g1", self.now + 5, self.now + 3600, "hour")
        self.assertEqual(len(ser), 1)
        self.assertAlmostEqual(ser[0]["core_hours"], 60.0 / 3600, places=4)

    def test_summary_splits_total_and_per_group(self):
        self.store.write_tick([_group(self.now, g="a"), _group(self.now, g="b")],
                              _platform(self.now), self.now, None)
        tot, per = self.store.summary(self.now - 10, self.now + 3600, "hour")
        self.assertAlmostEqual(tot[0]["cpu_core_seconds"], 120.0)
        self.assertEqual({r["group_name"] for r in per}, {"a", "b"})
        self.assertAlmostEqual(per[0]["gap_core_hours"], 60.0 / 3600, places=4)


if __name__ == "__main__":
    unittest.main()
