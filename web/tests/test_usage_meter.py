"""usage_meter: GPU card-seconds now flow through to the raw row and rollups.

End-to-end over a temporary DB with the host reads stubbed: two ticks (the
second with a real dt) must produce a non-zero ``gpu_compute_card_seconds`` and
carry it into both ``usage_hourly`` and ``usage_daily``.
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import usage_meter
import usage_store


class GpuMetering(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = usage_store.UsageStore(str(Path(self.tmp.name) / "u.db"))
        self.store.initialize()
        # fresh integral state; no CPU/mem path (no pods, cgroups unavailable)
        usage_meter._LAST.clear()
        usage_meter._LAST_TS = None
        usage_meter.INTERVAL = 30
        patches = [
            mock.patch.object(usage_meter, "_pods", return_value={}),
            mock.patch.object(
                usage_meter.cgroup_stats, "available", return_value=False
            ),
            mock.patch.object(
                usage_meter.gpu_stats, "per_pod_breakdown",
                return_value={"a": {0: {"mem": 4096.0, "util": 50.0}}},
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _row(self, rows, group):
        return next(r for r in rows if r["group_name"] == group)

    def test_t9_card_seconds_reach_the_raw_row(self):
        usage_meter.take_tick(1_700_000_000.0)   # seeds dt (first tick: dt=None)
        rows, _ = usage_meter.take_tick(1_700_000_030.0)
        row = self._row(rows, "a")
        self.assertEqual(row["dt"], 30.0)
        self.assertEqual(row["gpu_util_sum"], 50.0)
        self.assertAlmostEqual(row["gpu_compute_card_seconds"], 0.5 * 30.0)
        self.assertAlmostEqual(row["gpu_mem_gib_seconds"], 4096.0 / 1024 * 30.0)

    def test_t10_rollups_carry_card_seconds(self):
        now = 1_700_000_030.0
        usage_meter.take_tick(1_700_000_000.0)
        rows, prev = usage_meter.take_tick(now)
        self.store.write_tick(rows, now, prev)

        h = usage_store.hour_of(now)
        hourly = self.store.series("a", h, h + usage_store.HOUR, bucket="hour")
        self.assertAlmostEqual(
            hourly[0]["gpu_compute_card_seconds"], 0.5 * 30.0
        )
        d = usage_store.day_of(now)
        daily = self.store.series("a", d, d + usage_store.DAY, bucket="day")
        self.assertAlmostEqual(
            daily[0]["gpu_compute_card_seconds"], 0.5 * 30.0
        )


if __name__ == "__main__":
    unittest.main()
