"""gpu_stats: per-pod GPU attribution, incl. the MPS VRAM-share fallback.

Pure coverage of the attribution path — nvidia-smi, kubectl and the cgroup
reads are monkeypatched, so nothing touches the host. The kvcache is stubbed so
each test computes fresh and never writes Redis.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import gpu_stats


class ShareDeviceUtil(unittest.TestCase):
    """The pure split helper — no nvidia-smi, no cache."""

    def test_t1_mps_splits_by_vram_share(self):
        out = {
            "a": {0: {"mem": 2000, "util": 0.0}},
            "b": {0: {"mem": 6000, "util": 0.0}},
        }
        gpu_stats._share_device_util(out, {0: 100.0}, set())
        self.assertAlmostEqual(out["a"][0]["util"], 25.0)
        self.assertAlmostEqual(out["b"][0]["util"], 75.0)

    def test_t2_pmon_covered_card_is_left_alone(self):
        out = {"a": {0: {"mem": 2000, "util": 40.0}}}
        gpu_stats._share_device_util(out, {0: 100.0}, {0})
        self.assertAlmostEqual(out["a"][0]["util"], 40.0)

    def test_t3_partial_coverage_is_per_card(self):
        out = {
            "a": {0: {"mem": 1000, "util": 33.0}, 1: {"mem": 4000, "util": 0.0}},
            "b": {1: {"mem": 4000, "util": 0.0}},
        }
        gpu_stats._share_device_util(out, {0: 99.0, 1: 80.0}, {0})
        self.assertAlmostEqual(out["a"][0]["util"], 33.0)   # card 0 covered
        self.assertAlmostEqual(out["a"][1]["util"], 40.0)   # 80 * 4000/8000
        self.assertAlmostEqual(out["b"][1]["util"], 40.0)

    def test_t4_zero_total_vram_is_guarded(self):
        out = {"a": {0: {"mem": 0, "util": 7.0}}}
        gpu_stats._share_device_util(out, {0: 100.0}, set())
        self.assertAlmostEqual(out["a"][0]["util"], 7.0)    # untouched, no div0


class DeviceUtilByIndex(unittest.TestCase):
    def test_queries_card_level_util(self):
        gpus = [{"index": 0, "util": 12}, {"index": 1, "util": 99}]
        with mock.patch.object(gpu_stats, "_query_gpus", return_value=gpus):
            self.assertEqual(
                gpu_stats._device_util_by_index(), {0: 12.0, 1: 99.0}
            )

    def test_t5_query_failure_yields_empty_and_never_raises(self):
        with mock.patch.object(
            gpu_stats, "_query_gpus", side_effect=RuntimeError("no smi")
        ):
            self.assertEqual(gpu_stats._device_util_by_index(), {})


class PerPodBreakdown(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(gpu_stats.kvcache, "get", return_value=None)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(gpu_stats.kvcache, "set")
        p.start()
        self.addCleanup(p.stop)

    def _breakdown(self, apps, sm, groups, dev, real_dev=False):
        """Run per_pod_breakdown with every host read stubbed."""
        patches = [
            mock.patch.object(gpu_stats, "_compute_apps", return_value=apps),
            mock.patch.object(gpu_stats, "_pmon_sm", return_value=sm),
            mock.patch.object(gpu_stats, "_uid_to_group", return_value={}),
            mock.patch.object(
                gpu_stats, "_pid_group",
                side_effect=lambda pid, uids: groups.get(pid, ""),
            ),
        ]
        if not real_dev:
            patches.append(
                mock.patch.object(gpu_stats, "_device_util_by_index",
                                  return_value=dev)
            )
        for p in patches:
            p.start()
        try:
            return gpu_stats.per_pod_breakdown()
        finally:
            for p in patches:
                p.stop()

    def test_mps_path_shares_device_util(self):
        apps = [(0, "111", 2000), (0, "222", 6000)]
        bd = self._breakdown(apps, {}, {"111": "a", "222": "b"}, {0: 100.0})
        self.assertAlmostEqual(bd["a"][0]["util"], 25.0)
        self.assertAlmostEqual(bd["b"][0]["util"], 75.0)
        self.assertEqual(bd["a"][0]["mem"], 2000)

    def test_pmon_values_take_priority(self):
        apps = [(0, "111", 2000)]
        bd = self._breakdown(
            apps, {(0, "111"): 70.0}, {"111": "a"}, {0: 100.0}
        )
        self.assertAlmostEqual(bd["a"][0]["util"], 70.0)

    def test_t6_host_process_is_skipped(self):
        # pid 111 is a host process (no group); 222 is pod "a".
        apps = [(0, "111", 5000), (0, "222", 2000)]
        bd = self._breakdown(apps, {}, {"222": "a"}, {0: 100.0})
        self.assertEqual(set(bd), {"a"})               # host pid produced no row
        self.assertEqual(bd["a"][0]["mem"], 2000)

    def test_t5_query_failure_still_returns_mem_with_zero_util(self):
        apps = [(0, "222", 2000)]
        with mock.patch.object(
            gpu_stats, "_query_gpus", side_effect=RuntimeError("no smi")
        ):
            bd = self._breakdown(
                apps, {}, {"222": "a"}, None, real_dev=True
            )
        self.assertEqual(bd["a"][0]["mem"], 2000)
        self.assertEqual(bd["a"][0]["util"], 0.0)

    def test_t7_compute_apps_failure_yields_empty(self):
        with mock.patch.object(
            gpu_stats, "_compute_apps", side_effect=RuntimeError("boom")
        ):
            self.assertEqual(gpu_stats.per_pod_breakdown(), {})

    def test_t8_per_pod_usage_is_mem_only(self):
        bd = {"a": {0: {"mem": 1234, "util": 50.0}}}
        with mock.patch.object(
            gpu_stats, "per_pod_breakdown", return_value=bd
        ):
            self.assertEqual(gpu_stats.per_pod_usage(), {"a": {0: 1234}})


if __name__ == "__main__":
    unittest.main()
