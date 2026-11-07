"""defer_queue: contract wrapper, lifecycle, valley admission, fallback, reconcile.

No production file is touched: QUEUE_FILE/LOCK_FILE/LOG point at a temp dir,
``contract._group_dict`` is stubbed (so ``groups.load_state`` is never called),
and ``forecast``/``timeline`` reads are monkeypatched.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contract
import forecast
import timeline
import defer_queue as dq

NOW = 1_700_000_000


class DQCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self._q, self._l, self._log = dq.QUEUE_FILE, dq.LOCK_FILE, dq.LOG
        dq.QUEUE_FILE = os.path.join(self.dir, "defer_queue.json")
        dq.LOCK_FILE = dq.QUEUE_FILE + ".lock"
        dq.LOG = os.path.join(self.dir, "defer_queue.log")
        self.addCleanup(self._restore)
        # never touch the real group store
        p = mock.patch.object(contract, "_group_dict", lambda g: {})
        p.start()
        self.addCleanup(p.stop)

    def _restore(self):
        dq.QUEUE_FILE, dq.LOCK_FILE, dq.LOG = self._q, self._l, self._log

    def _dep(self, did="d1", kind="train", vram=12000, env=None, **kw):
        dep = {"id": did, "name": did, "kind": kind, "vram": vram}
        if env:
            dep["env"] = env
        dep.update(kw)
        return dep

    def _fc(self, free=None, age=10, valley=False, conf="med"):
        """Patch forecast/timeline for a test; ``free`` may be int or callable."""
        if callable(free):
            f = mock.patch.object(forecast, "free_mib", side_effect=free)
        else:
            f = mock.patch.object(forecast, "free_mib", return_value=free)
        return [f,
                mock.patch.object(forecast, "age_s", return_value=age),
                mock.patch.object(timeline, "is_valley", return_value=valley),
                mock.patch.object(timeline, "read", return_value={"confidence": conf})]


# ── contract wrapper ────────────────────────────────────────────
class Contract(DQCase):
    def test_should_defer_only_delayable_train(self):
        self.assertTrue(dq.should_defer("g", self._dep(env={"DEFER_OK": "true"})))
        self.assertFalse(dq.should_defer("g", self._dep(env={"DEFER_OK": "false"})))
        self.assertFalse(dq.should_defer("g", self._dep(kind="serve", env={"DEFER_OK": "true"})))
        self.assertFalse(dq.should_defer("g", self._dep()))          # default off

    def test_est_duration_and_deadline_kind_overlay(self):
        c = dq.contract_of("g", self._dep(env={"EST_DURATION_S": "7200",
                                               "DEADLINE_KIND": "hard"}))
        self.assertEqual(c["est_dur_s"], 7200)
        self.assertEqual(c["deadline_kind"], "hard")
        self.assertEqual(dq.contract_of("g", self._dep())["est_dur_s"],
                         dq.DEFAULT_EST_DURATION_S)


# ── lifecycle ───────────────────────────────────────────────────
class Lifecycle(DQCase):
    def test_enqueue_is_idempotent_for_live_items(self):
        a = dq.enqueue("g", self._dep("d1"))
        b = dq.enqueue("g", self._dep("d1"))
        self.assertEqual(a["deploy_id"], b["deploy_id"])
        self.assertEqual(dq.snapshot()["by_state"].get("queued"), 1)
        self.assertEqual(dq.snapshot()["counters"].get("enqueue_idempotent"), 1)

    def test_remove_is_idempotent(self):
        dq.enqueue("g", self._dep("d1"))
        self.assertIsNotNone(dq.remove("d1", reason="stop"))
        self.assertIsNone(dq.remove("d1"))
        self.assertEqual(dq.pending(), [])

    def test_mark_lifecycle_and_snapshot(self):
        dq.enqueue("g", self._dep("d1"))
        dq.mark_running("d1", 3)
        self.assertEqual(dq.pending()[0]["state"], "running")
        self.assertEqual(dq.pending()[0]["gpu"], 3)
        dq.mark_done("d1")
        self.assertIsNone(dq.mark_done("d1"))          # gone
        self.assertEqual(dq.snapshot()["by_state"], {})
        self.assertEqual(dq.snapshot()["counters"].get("done"), 1)

    def test_corrupt_state_is_inert(self):
        with open(dq.QUEUE_FILE, "w") as f:
            f.write("{ broken")
        self.assertEqual(dq.pending(), [])
        dq.enqueue("g", self._dep("d1"))               # recovers
        self.assertEqual(len(dq.pending()), 1)

    def test_roundtrip_keeps_all_fields(self):
        dq.enqueue("g", self._dep("d1", env={"DEADLINE": "1"}))
        with open(dq.QUEUE_FILE) as f:
            d = json.load(f)
        self.assertEqual(d["schema"], 1)
        self.assertEqual(d["items"]["d1"]["deadline_ts"], 1)


# ── admission ───────────────────────────────────────────────────
class Admit(DQCase):
    def test_holds_until_valley_and_commits_in_valley(self):
        dq.enqueue("g", self._dep("d1"))
        ctx = self._fc(free=30000, valley=False)
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            self.assertEqual(dq.admit(now=NOW), [])
        self.assertEqual(dq.pending()[0]["state"], "deferred")
        self.assertEqual(dq.pending()[0]["last_decision"]["reason"], "await-valley")
        ctx = self._fc(free=30000, valley=True)
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            out = dq.admit(now=NOW)
        self.assertEqual([o["deploy_id"] for o in out], ["d1"])
        self.assertEqual(out[0]["reason"], "valley")

    def test_no_room_defers(self):
        dq.enqueue("g", self._dep("d1", vram=12000))
        ctx = self._fc(free=12000, valley=True)        # exactly need, margin unfits
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            self.assertEqual(dq.admit(now=NOW), [])
        self.assertIn("no-room", dq.pending()[0]["last_decision"]["reason"])

    def test_deadline_forces_start_outside_valley(self):
        dq.enqueue("g", self._dep("d1", env={"DEADLINE": "1",
                                             "EST_DURATION_S": "3600"}))
        ctx = self._fc(free=30000, valley=False)
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            out = dq.admit(now=NOW)
        self.assertEqual([o["deploy_id"] for o in out], ["d1"])
        self.assertEqual(out[0]["reason"], "deadline-forced")

    def test_edf_order(self):
        # distinct groups so the iteration order is observable via free_mib calls
        dq.enqueue("gL", self._dep("late", env={"DEADLINE": "2000000000"}))
        dq.enqueue("gS", self._dep("soon", env={"DEADLINE": "1000000000"}))
        seen = []
        ctx = self._fc(free=None, valley=True)
        with ctx[0] as m, ctx[1], ctx[2], ctx[3]:
            m.side_effect = lambda group, now=None: (seen.append(group) or 10 ** 9)
            dq.admit(now=NOW)
        self.assertEqual(seen, ["gS", "gL"])          # earliest deadline first

    def test_fallback_when_forecast_stale(self):
        dq.enqueue("g", self._dep("d1"))
        ctx = self._fc(free=30000, age=None, valley=False)   # no forecast
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            out = dq.admit(now=NOW)
        self.assertEqual([o["deploy_id"] for o in out], ["d1"])   # reactive = runs
        self.assertEqual(out[0]["reason"], "reactive-fallback")
        self.assertGreaterEqual(dq.snapshot()["counters"]["forecast_fallback"], 1)

    def test_earliest_start_blocks(self):
        dq.enqueue("g", self._dep("d1", earliest_start=NOW + 1000))
        ctx = self._fc(free=30000, valley=True)
        with ctx[0], ctx[1], ctx[2], ctx[3]:
            self.assertEqual(dq.admit(now=NOW), [])
        self.assertEqual(dq.pending()[0]["last_decision"]["reason"], "not-before-earliest")

    def test_hard_deadline_miss_policy_drops(self):
        dq.enqueue("g", self._dep("d1", env={"DEADLINE": "1", "DEADLINE_KIND": "hard"}))
        ctx = self._fc(free=30000, valley=True)
        with mock.patch.object(dq, "DEADLINE_MISS_POLICY", "drop"), \
             ctx[0], ctx[1], ctx[2], ctx[3]:
            self.assertEqual(dq.admit(now=NOW), [])
        self.assertEqual(dq.snapshot()["by_state"], {})
        self.assertEqual(dq.snapshot()["counters"].get("missed"), 1)


# ── reconcile ───────────────────────────────────────────────────
class Reconcile(DQCase):
    def test_running_but_gone_from_alloc_is_finished(self):
        dq.enqueue("g", self._dep("d1"))
        dq.mark_running("d1", 2)
        sched = mock.MagicMock()
        sched.all_deploys.return_value = {}            # not placed anymore
        with mock.patch.dict(sys.modules, {"scheduler": sched}):
            done = dq.reconcile(now=NOW)
        self.assertEqual(done, ["d1"])
        self.assertEqual(dq.pending(), [])


if __name__ == "__main__":
    unittest.main()
