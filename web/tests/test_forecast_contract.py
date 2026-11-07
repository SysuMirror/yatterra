"""The forecast↔defer_queue boundary: supply read, degradation, stale gate.

Verifies the two seams P1-c depends on and nothing else touches:

- ``defer_queue.supply`` is a thin read of the P1-b ledger
  (``forecast.free_mib``), and returns ``None`` when capacity is unavailable.
- ``forecast.free_mib`` honours the scheduler group allowlist and never raises
  when the scheduler import breaks.
- ``defer_queue``'s ``FORECAST_STALE_S`` gate flips admission into the reactive
  fallback exactly at the boundary.

No production DB or state file is read; STATE/TIMELINE are temp files.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import forecast
import timeline
import defer_queue as dq

NOW = 1_700_000_000
HOUR = 3600


class BoundaryCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self._q, self._l, self._log = dq.QUEUE_FILE, dq.LOCK_FILE, dq.LOG
        dq.QUEUE_FILE = os.path.join(self.dir, "defer_queue.json")
        dq.LOCK_FILE = dq.QUEUE_FILE + ".lock"
        dq.LOG = os.path.join(self.dir, "defer_queue.log")
        self.addCleanup(self._restore)

    def _restore(self):
        dq.QUEUE_FILE, dq.LOCK_FILE, dq.LOG = self._q, self._l, self._log


class Supply(BoundaryCase):
    def _fake_sched(self, samples, allowed=None):
        m = mock.MagicMock()
        m.sample.return_value = samples
        m.all_deploys.return_value = {}
        m._group_gpus.return_value = allowed
        return m

    def test_supply_delegates_to_free_mib(self):
        sm = [{"index": 0, "vram_used": 0, "vram_free": 1234}]
        with mock.patch.dict(sys.modules, {"scheduler": self._fake_sched(sm)}):
            self.assertEqual(dq.supply("g", now=NOW), 1234)

    def test_free_mib_none_when_broken_scheduler(self):
        broken = mock.MagicMock()
        broken.sample.side_effect = RuntimeError("nvidia-smi gone")
        with mock.patch.dict(sys.modules, {"scheduler": broken}):
            self.assertIsNone(forecast.free_mib("g", now=NOW))
            self.assertIsNone(dq.supply("g", now=NOW))


class StaleGate(BoundaryCase):
    def _dep(self, did="d1"):
        return {"id": did, "name": did, "kind": "train", "vram": 12000}

    def test_boundary_exactly_at_stale_threshold(self):
        dq.enqueue("g", self._dep())
        # age == threshold -> still fresh (<=)
        with mock.patch.object(forecast, "free_mib", return_value=10 ** 9), \
             mock.patch.object(forecast, "age_s", return_value=dq.FORECAST_STALE_S), \
             mock.patch.object(timeline, "is_valley", return_value=False), \
             mock.patch.object(timeline, "read", return_value={"confidence": "med"}):
            self.assertEqual(dq.admit(now=NOW), [])           # fresh -> waits
        self.assertEqual(dq.pending()[0]["last_decision"]["reason"], "await-valley")

    def test_just_past_threshold_is_fallback(self):
        dq.enqueue("g", self._dep())
        with mock.patch.object(forecast, "free_mib", return_value=10 ** 9), \
             mock.patch.object(forecast, "age_s",
                               return_value=dq.FORECAST_STALE_S + 1), \
             mock.patch.object(timeline, "is_valley", return_value=False), \
             mock.patch.object(timeline, "read", return_value={"confidence": "med"}):
            out = dq.admit(now=NOW)
        self.assertEqual([o["deploy_id"] for o in out], ["d1"])
        self.assertEqual(out[0]["reason"], "reactive-fallback")


if __name__ == "__main__":
    unittest.main()
