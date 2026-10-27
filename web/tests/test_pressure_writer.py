"""pressure_writer: level classification, hysteresis state machine, window stats.

Pure-function coverage of the v3 signal logic — no host sampling, no nvidia-smi,
no writes. The sliding window and the level hysteresis keep module-global state,
so each test resets those explicitly.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pressure_writer as pw


class LevelClassify(unittest.TestCase):
    def test_frac_thresholds(self):
        self.assertEqual(pw._level(0.95), "high")
        self.assertEqual(pw._level(0.80), "high")
        self.assertEqual(pw._level(0.79), "med")
        self.assertEqual(pw._level(0.50), "med")
        self.assertEqual(pw._level(0.10), "low")
        self.assertIsNone(pw._level(None))

    def test_temp_uses_own_thresholds(self):
        self.assertEqual(pw._level_temp(90), "high")
        self.assertEqual(pw._level_temp(80), "med")
        self.assertEqual(pw._level_temp(40), "low")
        self.assertIsNone(pw._level_temp(None))

    def test_gpu_level_aligned_with_tier2_basis(self):
        """level.gpu must read the per-card max window, not the average: two
        cards at 0.99 with one idle -> avg 0.66 ('med') but max 0.99 ('high')."""
        self.assertEqual(pw._LEVEL_DIMS["gpu"], "gpu_max")
        self.assertEqual(pw._level(0.99), "high")   # tier-2 evicts here (>0.80)
        self.assertEqual(pw._level(0.66), "med")    # the old diluted reading

    def test_gpu_mem_uses_near_oom_band(self):
        """The permanent co-located VRAM baseline (~0.94) must NOT read high;
        only genuine near-OOM does, mirroring tier-2's 0.97 gate."""
        self.assertEqual(pw._raw_level("gpu_mem", 0.94), "med")
        self.assertEqual(pw._raw_level("gpu_mem", 0.98), "high")
        self.assertEqual(pw._raw_level("gpu_mem", 0.50), "low")


class WindowStats(unittest.TestCase):
    def setUp(self):
        for k in pw._win:
            pw._win[k].clear()

    def test_avg_peak_and_none_skipping(self):
        for v in (0.2, 0.6, None, 0.4):
            pw._push("cpu", v)
        st = pw._stat("cpu", 0.4)
        self.assertEqual(st["n"], 3)          # None not counted
        self.assertEqual(st["peak"], 0.6)
        self.assertAlmostEqual(st["avg"], 0.4, places=6)
        self.assertEqual(st["now"], 0.4)

    def test_empty_window(self):
        st = pw._stat("cpu", None)
        self.assertEqual(st, {"now": None, "avg": None, "peak": None, "n": 0})


class Hysteresis(unittest.TestCase):
    """DWELL_UP/DWELL_DOWN are read at call time, so patch the module globals."""

    def setUp(self):
        for d in pw._hyst:
            pw._hyst[d] = {"lvl": None, "up": 0, "down": 0}
        for k in pw._win:
            pw._win[k].clear()

    def _feed(self, dim, samples, raw):
        # push samples into the dim's window, then ask for the stable level
        key = pw._LEVEL_DIMS[dim]
        for v in samples:
            pw._push(key, v)
        return pw._stable_level(dim, raw)

    def test_rising_edge_needs_dwell(self):
        """A single hot cycle does not flip to high; DWELL_UP hot cycles do."""
        self.assertEqual(self._feed("cpu", [0.2], "low"), "low")     # baseline
        # one hot cycle -> still low (dwell not met)
        pw._win["cpu"].clear()
        self.assertEqual(self._feed("cpu", [0.95], "high"), "low")
        pw._win["cpu"].clear()
        self.assertEqual(self._feed("cpu", [0.95], "high"), "high")  # DWELL_UP=2

    def test_peak_can_trigger_high(self):
        """peak>=HIGH satisfies 'hot' even when avg is below HIGH."""
        self.assertEqual(self._feed("cpu", [0.3], "low"), "low")
        # window avg = (0.3+0.95)/2 = 0.625 (<0.8) but peak 0.95 -> hot
        pw._win["cpu"].clear()
        for v in (0.3, 0.95):
            pw._push("cpu", v)
        self.assertEqual(pw._stable_level("cpu", "med"), "low")      # up=1
        pw._win["cpu"].clear()
        for v in (0.3, 0.95):
            pw._push("cpu", v)
        self.assertEqual(pw._stable_level("cpu", "med"), "high")     # up=2

    def test_falling_edge_needs_longer_dwell(self):
        pw._win["cpu"].clear()
        self.assertEqual(self._feed("cpu", [0.95], "high"), "high")  # seed high
        self.assertEqual(self._feed("cpu", [0.95], "high"), "high")
        # now cool: needs DWELL_DOWN cycles below MED before leaving high
        for _ in range(pw.DWELL_DOWN - 1):
            pw._win["cpu"].clear()
            self.assertEqual(self._feed("cpu", [0.1], "low"), "high")
        pw._win["cpu"].clear()
        self.assertEqual(self._feed("cpu", [0.1], "low"), "low")


if __name__ == "__main__":
    unittest.main()
