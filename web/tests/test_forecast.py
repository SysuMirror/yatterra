"""forecast: STL-lite, degradation ladder, valley windows, correction, publish.

``load_series`` is monkeypatched with synthetic data so no production DB is
read; STATE_FILE and TIMELINE_FILE point at a temp dir.
"""
import json
import math
import os
import random as _random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import forecast
import timeline

NOW = 1_700_000_000
HOUR = 3600


def _series(n, base=10.0, amp=4.0, ts0=None, period=24, noise=0.0):
    """Hourly rows with a clean daily cycle (+optional noise); ts hour-aligned."""
    ts0 = ts0 if ts0 is not None else (NOW // HOUR) * HOUR - (n - 1) * HOUR
    rng = _random.Random(1234)
    return [{"ts": ts0 + i * HOUR,
             "value": (base + amp * math.sin(2 * math.pi * (i % period) / period)
                       + (rng.gauss(0.0, noise) if noise else 0.0))}
            for i in range(n)]


class ForecastCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self._state = forecast.STATE_FILE
        self._tl = timeline.TIMELINE_FILE
        forecast.STATE_FILE = os.path.join(self.dir, "forecast_state.json")
        timeline.TIMELINE_FILE = os.path.join(self.dir, "timeline.json")
        self.addCleanup(self._restore)

    def _restore(self):
        forecast.STATE_FILE = self._state
        timeline.TIMELINE_FILE = self._tl

    def _patch(self, rows):
        return mock.patch.object(forecast, "load_series", return_value=rows)


# ── store fall-back ────────────────────────────────────────────
class StoreFallback(ForecastCase):
    def _fake(self, name, rows):
        mod = mock.MagicMock()

        class _S:
            def summary(self, *a):
                return (rows, {})

            def series(self, *a):
                return rows
        mod.FeatureStore = mod.UsageStore = _S
        return mod

    def test_partial_only_feature_table_falls_through_to_metering(self):
        import time as _t
        now = _t.time()
        hour = int(now // HOUR) * HOUR
        partial = [{"bucket_start": hour, "cpu_core_seconds": 999.0}]   # dropped
        usable = [{"bucket_start": hour - (i + 1) * HOUR, "cpu_core_seconds": 3600.0}
                  for i in range(3)]
        mods = {"feature_store": self._fake("feature_store", partial),
                "usage_store": self._fake("usage_store", usable)}
        with mock.patch.dict(sys.modules, mods):
            rows = forecast.load_series(None, "cpu", "hour")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["value"], 1.0)


# ── supply ledger (P1-c prerequisite) ───────────────────────────
class Capacity(ForecastCase):
    def _fake(self, samples, alloc=None, allowed=None):
        mod = mock.MagicMock()
        mod.sample.return_value = samples
        mod.all_deploys.return_value = alloc or {}
        mod._group_gpus.return_value = allowed
        return mod

    def _patch_sched(self, mod):
        return mock.patch.dict(sys.modules, {"scheduler": mod})

    def test_unavailable_when_no_gpus(self):
        with self._patch_sched(self._fake([])):
            cap = forecast.capacity(now=NOW)
            self.assertEqual(cap["source"], "unavailable")
            self.assertEqual(cap["cards"], [])
            self.assertIsNone(forecast.free_mib(now=NOW))

    def test_cards_and_committed_only_count_live_status(self):
        sm = [{"index": 0, "vram_used": 100, "vram_free": 900},
              {"index": 1, "vram_used": 50, "vram_free": 950}]
        alloc = {
            "a": {"gpu": 0, "status": "running", "vram": 200},
            "b": {"gpu": 0, "status": "queued", "vram": 100},
            "c": {"gpu": 1, "status": "deferred", "vram": 50},
            "d": {"gpu": 0, "status": "stopped", "vram": 999},   # ignored
        }
        with self._patch_sched(self._fake(sm, alloc)):
            cap = forecast.capacity(now=NOW)
        self.assertEqual(cap["source"], "nvidia-smi")
        self.assertEqual(cap["cards"][0]["total_mib"], 1000)
        self.assertEqual(cap["cards"][0]["committed_mib"], 300)
        self.assertEqual(cap["cards"][1]["committed_mib"], 50)
        self.assertEqual(cap["free_total_mib"], 1850)

    def test_free_mib_respects_group_allowlist(self):
        sm = [{"index": 0, "vram_used": 100, "vram_free": 900},
              {"index": 1, "vram_used": 50, "vram_free": 950}]
        with self._patch_sched(self._fake(sm, {}, allowed={0})):
            self.assertEqual(forecast.free_mib(group="g", now=NOW), 900)
        with self._patch_sched(self._fake(sm, {}, allowed=None)):
            self.assertEqual(forecast.free_mib(group="g", now=NOW), 950)


# ── STL-lite ────────────────────────────────────────────────────
class Stl(ForecastCase):
    def test_empty(self):
        self.assertEqual(forecast.stl_decompose([]), ([], [], []))

    def test_seasonal_is_recovered_on_clean_cycle(self):
        vals = [10 + 4 * math.sin(2 * math.pi * (i % 24) / 24) for i in range(96)]
        trend, seasonal, resid = forecast.stl_decompose(vals)
        self.assertEqual(len(trend), len(seasonal), len(vals))
        # additive identity holds everywhere
        for i in range(len(vals)):
            self.assertAlmostEqual(trend[i] + seasonal[i] + resid[i], vals[i], places=6)
        # seasonal profile is zero-mean and roughly sinusoidal
        self.assertAlmostEqual(forecast._mean(seasonal), 0.0, places=6)
        self.assertGreater(max(seasonal) - min(seasonal), 6.0)

    def test_robust_ignores_an_outlier_spike(self):
        vals = [10.0] * 60
        vals[30] = 1000.0
        s_robust = forecast.stl_decompose(vals, robust=True)[1]
        s_plain = forecast.stl_decompose(vals, robust=False)[1]
        self.assertLess(max(abs(x) for x in s_robust),
                        max(abs(x) for x in s_plain))


# ── valley windows ──────────────────────────────────────────────
class ValleyWindows(ForecastCase):
    def test_flat_series_has_no_window(self):
        res = {"confidence": "low",
               "slots": [{"slot_start": i * HOUR, "p50": 5.0} for i in range(5)]}
        self.assertEqual(forecast.valley_windows(res), [])

    def test_contiguous_low_run_is_found_longest_first(self):
        p = [9, 9, 1, 1, 1, 1, 9, 9, 2, 2]      # two low runs, sizes 4 and 2
        res = {"confidence": "med",
               "slots": [{"slot_start": i * HOUR, "p50": v} for i, v in enumerate(p)]}
        ws = forecast.valley_windows(res)
        self.assertEqual(len(ws), 2)
        self.assertEqual(ws[0]["n_slots"], 4)
        self.assertEqual(ws[0]["start"], 2 * HOUR)
        self.assertEqual(ws[0]["end"], 6 * HOUR)
        self.assertEqual(ws[1]["n_slots"], 2)


# ── prediction ladder ───────────────────────────────────────────
class Predict(ForecastCase):
    def test_empty_history_is_none(self):
        with self._patch([]):
            r = forecast.predict_supply(None, now=NOW)
        self.assertEqual(r["kind"], "none")
        self.assertEqual(r["slots"], [])
        self.assertEqual(r["history_hours"], 0)

    def test_dead_column_is_refused(self):
        rows = [{"ts": (NOW // HOUR) * HOUR - (10 - i) * HOUR, "value": 0.0}
                for i in range(10)]
        with self._patch(rows):
            r = forecast.predict_supply(None, metric="gpu", now=NOW)
        self.assertEqual(r["kind"], "none")
        self.assertEqual(r.get("note"), "dead-column")
        self.assertEqual(r["slots"], [])

    def test_ladder_none_flat_climatology_seasonal(self):
        for n, kind in ((3, "none"), (12, "flat"), (30, "climatology"),
                        (72, "seasonal")):
            with self._patch(_series(n)):
                r = forecast.predict_supply(None, now=NOW)
            self.assertEqual(r["kind"], kind, n)

    def test_slots_align_and_local_offset(self):
        with self._patch(_series(72)):
            r = forecast.predict_supply(None, horizon=6, now=NOW)
        self.assertEqual(len(r["slots"]), 6)
        base = math.ceil(NOW / HOUR) * HOUR
        for k, s in enumerate(r["slots"]):
            self.assertEqual(s["slot_start"], base + k * HOUR)
            self.assertEqual(s["hour_local"], (s["hour_of_day"] + 8) % 24)
            self.assertLessEqual(s["p10"], s["p50"])
            self.assertLessEqual(s["p50"], s["p90"])
            self.assertGreaterEqual(s["p10"], 0.0)

    def test_stale_history_downgrades_confidence(self):
        end = (NOW // HOUR) * HOUR
        fresh_rows = _series(72, ts0=end - 71 * HOUR)          # ends at NOW
        stale_rows = _series(72, ts0=end - 81 * HOUR)          # ends 10h ago
        with self._patch(fresh_rows):
            fresh = forecast.predict_supply(None, now=NOW)
        with self._patch(stale_rows):
            stale = forecast.predict_supply(None, now=NOW)
        self.assertFalse(fresh["stale"])
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["confidence"], "low")


# ── correction + error quantile ─────────────────────────────────
class Correction(ForecastCase):
    def test_update_moves_bias_toward_residual(self):
        with self._patch(_series(72)):
            r = forecast.predict_supply(None, now=NOW)
        slot0 = r["slots"][0]["slot_start"]
        pred = r["slots"][0]["mean"]
        out = forecast.update_correction(None, "cpu", pred + 10.0, slot0, now=NOW)
        self.assertAlmostEqual(out["resid"], 10.0, places=4)
        self.assertAlmostEqual(out["bias_ewma"], 1.0, places=4)   # 0.1 * 10
        # a second correction compounds
        out2 = forecast.update_correction(None, "cpu", pred + 10.0, slot0, now=NOW)
        self.assertAlmostEqual(out2["bias_ewma"], 1.9, places=4)

    def test_observe_corrects_against_last_prediction(self):
        with self._patch(_series(72)):
            r = forecast.predict_supply(None, now=NOW)      # stores last_pred
        slot = r["slots"][0]
        ts0, pred = slot["slot_start"], slot["mean"]
        rows = _series(72, ts0=ts0 - 71 * HOUR)
        rows[-1] = {"ts": ts0, "value": pred + 7.0}         # came in 7.0 high
        with self._patch(rows):
            out = forecast.observe(None, "cpu", now=NOW)
        self.assertAlmostEqual(out["resid"], 7.0, places=4)
        self.assertAlmostEqual(out["bias_ewma"], 0.7, places=4)

    def test_error_quantile_cold_is_none(self):
        self.assertIsNone(forecast.error_quantile("cpu"))

    def test_error_quantile_after_corrections(self):
        for e in (1.0, 2.0, 3.0, 4.0, 5.0):
            state = forecast.load_state()
            ss = forecast._series_state(state, None, "cpu")
            ss.setdefault("abs_err", []).append(e)
            forecast.save_state(state)
        q = forecast.error_quantile("cpu", eps=0.8)
        self.assertIsNotNone(q)
        self.assertGreaterEqual(q, 4.0)


# ── state robustness ────────────────────────────────────────────
class StateFile(ForecastCase):
    def test_corrupt_state_is_inert(self):
        with open(forecast.STATE_FILE, "w") as f:
            f.write("{ broken")
        self.assertEqual(forecast.load_state(), {})
        self.assertIsNone(forecast.age_s(NOW))

    def test_roundtrip(self):
        forecast.save_state({"published_ts": NOW - 5})
        self.assertEqual(forecast.load_state()["published_ts"], NOW - 5)
        self.assertEqual(forecast.age_s(NOW), 5.0)


# ── publish + tick throttle ─────────────────────────────────────
class Publish(ForecastCase):
    def test_snapshot_writes_timeline_and_reads_back(self):
        with self._patch(_series(96)):
            out = forecast.snapshot(now=NOW)
        self.assertEqual(out["schema"], timeline.SCHEMA)
        self.assertIn(out["phase"], ("peak", "shoulder", "valley"))
        self.assertEqual(timeline.read()["phase"], out["phase"])
        self.assertIsNotNone(forecast.age_s(NOW))

    def test_tick_throttles_within_window(self):
        with self._patch(_series(96)):
            first = forecast.tick(now=NOW)
            self.assertIsNotNone(first)
            self.assertIsNone(forecast.tick(now=NOW + 60))        # < PUBLISH_S
            again = forecast.tick(now=NOW + forecast.PUBLISH_S + 1)
            self.assertIsNotNone(again)

    def test_snapshot_survives_empty_forecast(self):
        with self._patch([]):
            out = forecast.snapshot(now=NOW)
        self.assertEqual(out["phase"], "shoulder")
        self.assertEqual(out["confidence"], "low")


# ── backtest ────────────────────────────────────────────────────
class Backtest(ForecastCase):
    def test_too_little_history(self):
        with self._patch(_series(10)):
            r = forecast.backtest()
        self.assertEqual(r["folds"], 0)
        self.assertIsNone(r["mae"])

    def test_clean_cycle_backtests_well(self):
        with self._patch(_series(24 * 8)):
            r = forecast.backtest(holdout_h=24, folds=3)
        self.assertEqual(r["folds"], 3)
        self.assertIsNotNone(r["mae"])
        self.assertLess(r["mae"], 1.0)              # near-noise-free cycle

    def test_noisy_cycle_coverage_is_meaningful(self):
        with self._patch(_series(24 * 8, noise=0.5)):
            r = forecast.backtest(holdout_h=24, folds=3)
        self.assertEqual(r["folds"], 3)
        self.assertIsNotNone(r["coverage"])
        # the p10-p90 band should cover the bulk — but not all — of the holdout
        self.assertGreater(r["coverage"], 0.6)
        self.assertLessEqual(r["coverage"], 1.0)


if __name__ == "__main__":
    unittest.main()
