"""feat_loop: pressure sampling is crash-proof, group rates are read-only.

No real meter DB or pressure file needed — both are temp files / fakes. Module
globals (_LAST_TS, PRESSURE_FILE) are saved and restored.
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import feat_loop
import usage_store


class PlatformCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.pf = os.path.join(tmp.name, "pressure.json")
        self._saved = feat_loop.PRESSURE_FILE
        feat_loop.PRESSURE_FILE = self.pf
        self.addCleanup(self._restore)

    def _restore(self):
        feat_loop.PRESSURE_FILE = self._saved

    def _write(self, obj):
        with open(self.pf, "w") as f:
            json.dump(obj, f)


class SamplePlatform(PlatformCase):
    def test_missing_file_returns_none(self):
        self.assertIsNone(feat_loop.sample_platform(time.time()))

    def test_malformed_json_returns_none(self):
        with open(self.pf, "w") as f:
            f.write("{ not json")
        self.assertIsNone(feat_loop.sample_platform(time.time()))

    def test_non_dict_returns_none(self):
        self._write([1, 2, 3])
        self.assertIsNone(feat_loop.sample_platform(time.time()))

    def test_maps_stats_and_level(self):
        self._write({
            "ts": 1000.0, "level": {"cpu": "high", "gpu": "low"},
            "stats": {"cpu": {"avg": 0.3, "peak": 0.9},
                      "gpu": {"avg": 0.1, "peak": 0.5},
                      "gpu_max": {"peak": 0.5},
                      "gpu_mem": {"avg": 0.2}, "gpu_mem_max": {"peak": 0.6},
                      "mem": {"avg": 0.4, "peak": 0.7},
                      "psi_max": {"peak": 3.0}, "psi_cpu": {"peak": 2.0},
                      "psi_mem": {"peak": 1.0}, "psi_io": {"peak": 0.5},
                      "bw": {"avg": 0.1, "peak": 0.2},
                      "disk_max": {"peak": 0.45}},
        })
        row = feat_loop.sample_platform(1000.0, 30.0)
        self.assertEqual(row["cpu_avg"], 0.3)
        self.assertEqual(row["cpu_max"], 0.9)
        self.assertEqual(row["gpu_max"], 0.5)
        self.assertEqual(row["gpu_mem_max"], 0.6)
        self.assertEqual(row["psi_max"], 3.0)
        self.assertEqual(row["psi_cpu_max"], 2.0)
        self.assertEqual(row["psi_io_max"], 0.5)
        self.assertEqual(row["disk_max"], 0.45)
        self.assertEqual(row["dt"], 30.0)
        self.assertEqual(json.loads(row["level_json"]), {"cpu": "high", "gpu": "low"})

    def test_missing_stats_are_none_not_crash(self):
        self._write({"ts": 1000.0, "level": {}})
        row = feat_loop.sample_platform(1000.0, 30.0)
        self.assertIsNone(row["cpu_avg"])
        self.assertEqual(row["level_json"], "{}")


class SampleGroups(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "usage.db")
        con = sqlite3.connect(self.path)
        con.execute(
            "CREATE TABLE usage_samples (group_name TEXT, ts REAL, dt REAL,"
            " cpu_core_seconds REAL, cpu_req_core_seconds REAL, mem_gib REAL,"
            " gpu_util_sum REAL, gpu_mem_mib REAL)")
        con.execute("INSERT INTO usage_samples VALUES ('g1',1000.0,30.0,60.0,120.0,8.0,50.0,4096.0)")
        con.execute("INSERT INTO usage_samples VALUES ('g2',1000.0,0.0,0.0,0.0,0.0,0.0,0.0)")
        con.execute("INSERT INTO usage_samples VALUES ('g3',100.0,30.0,60.0,120.0,1.0,0.0,0.0)")
        con.commit()
        con.close()
        p = mock.patch.object(feat_loop, "UsageStore",
                              lambda: usage_store.UsageStore(self.path))
        p.start()
        self.addCleanup(p.stop)

    def test_rates_from_integrals_and_zero_dt_skipped(self):
        rows = feat_loop.sample_groups(990.0, 1010.0)
        self.assertEqual([r["group_name"] for r in rows], ["g1"])
        r = rows[0]
        self.assertAlmostEqual(r["cpu_cores"], 2.0)
        self.assertAlmostEqual(r["cpu_req_cores"], 4.0)
        self.assertAlmostEqual(r["gpu_util"], 50.0)
        self.assertAlmostEqual(r["gpu_mem_mib"], 4096.0)
        self.assertAlmostEqual(r["dt"], 30.0)

    def test_window_is_bounded_and_stale_backlog_excluded(self):
        # `since` far in the past is clamped to now-4*INTERVAL (890); the ts=100
        # row is dropped, the ts=1000 row is kept.
        rows = feat_loop.sample_groups(0.0, 1010.0)
        self.assertEqual([r["group_name"] for r in rows], ["g1"])

    def test_missing_db_reads_empty(self):
        p = mock.patch.object(feat_loop, "UsageStore",
                              lambda: usage_store.UsageStore(self.path + ".nope"))
        p.start()
        self.addCleanup(p.stop)
        self.assertEqual(feat_loop.sample_groups(990.0, 1010.0), [])


class TakeTick(unittest.TestCase):
    def setUp(self):
        self._saved = (feat_loop._LAST_TS, feat_loop.INTERVAL)
        feat_loop.INTERVAL = 30
        feat_loop._LAST_TS = None
        self.addCleanup(self._restore)

    def _restore(self):
        feat_loop._LAST_TS, feat_loop.INTERVAL = self._saved

    def test_advances_last_ts_and_passes_prev(self):
        with mock.patch.object(feat_loop, "sample_groups", return_value=[]) as g, \
             mock.patch.object(feat_loop, "sample_platform", return_value={"ts": 1}):
            groups, platform, prev = feat_loop.take_tick(1000.0)
            self.assertIsNone(prev)
            self.assertEqual(groups, [])
            self.assertEqual(platform, {"ts": 1})
            self.assertEqual(feat_loop._LAST_TS, 1000.0)
            g.assert_called_once_with(None, 1000.0)
            feat_loop.take_tick(1030.0)
            g.assert_called_with(1000.0, 1030.0)

    def test_dt_clamps_a_huge_gap(self):
        feat_loop._LAST_TS = 1000.0
        self.assertEqual(feat_loop._dt(1030.0), 30.0)
        self.assertEqual(feat_loop._dt(1000.0 + 99999), 30.0)  # clamped
        feat_loop._LAST_TS = None
        self.assertIsNone(feat_loop._dt(2000.0))


if __name__ == "__main__":
    unittest.main()
