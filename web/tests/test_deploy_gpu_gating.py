"""GPU gating: a deploy may only pin a card / train when the POD owns cards.

The pod manifest injects ``NVIDIA_VISIBLE_DEVICES`` only for ``type == "gpu"``
groups, so on a CPU pod ``gpu`` / ``vram`` / ``kind='train'`` (and the P1-c
contract env) are dead settings: a pinned card would look busy to the scheduler
while the container can't see it, and a queued train job would wait forever.

Covers the new seams:
  - ``deploys.group_gpu_ids`` / ``pod_supports_gpu`` / ``sanitize_gpu_fields``
  - ``deploys.gpu_fields_normalized`` (the API's ``gpu_normalized`` flag)
  - ``deploys.add`` / ``deploys.update`` normalising on a CPU pod
  - ``scheduler.group_has_gpu`` / ``gpu_for_deploy`` short-circuiting
No production file is touched: ``deploys.STATE_FILE`` points at a temp dir and
``groups.load_state`` is stubbed.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import deploys
import groups
import scheduler


_MISSING = object()


def state(groups_map):
    return {"groups": groups_map}


def patch_state(test, groups_map):
    """Stub ``groups.load_state`` wherever a caller might resolve it.

    ``groups_map`` is the pod table, or a callable used as ``load_state`` itself
    (e.g. one that raises).  Other test modules swap ``sys.modules['groups']``
    for a fake and don't put the real one back, and module-level ``import
    groups`` binds whichever object was cached at import time — so patch every
    live reference, not just one.
    """
    fake = groups_map if callable(groups_map) else (lambda: state(groups_map))
    # ``scheduler`` resolves ``groups`` lazily via ``import groups`` at call
    # time, so the entry has to exist in sys.modules (a test that popped it would
    # otherwise hand us a freshly-imported, unpatched module).
    prev = sys.modules.get("groups", _MISSING)
    sys.modules["groups"] = groups
    test.addCleanup(lambda: sys.modules.pop("groups", None)
                    if prev is _MISSING else sys.modules.__setitem__("groups", prev))
    mods = {id(m): m for m in (groups, sys.modules.get("groups"),
                               getattr(deploys, "groups", None),
                               getattr(scheduler, "groups", None))
            if m is not None}
    for mod in mods.values():
        try:
            p = mock.patch.object(mod, "load_state", fake)
        except (AttributeError, TypeError):
            continue
        p.start()
        test.addCleanup(p.stop)


GPU_POD = {"type": "gpu", "gpus": [2, 0], "node": "auto"}
CPU_POD = {"type": "cpu", "gpus": [], "node": "auto"}
WIN_POD = {"type": "windows", "gpus": [], "node": "auto"}


class Lookup(unittest.TestCase):
    def setUp(self):
        patch_state(self, {"g": GPU_POD, "c": CPU_POD, "w": WIN_POD})

    def test_gpu_pod_ids_sorted(self):
        self.assertEqual(deploys.group_gpu_ids("g"), [0, 2])
        self.assertTrue(deploys.pod_supports_gpu("g"))

    def test_cpu_and_windows_pods_have_none(self):
        for name in ("c", "w"):
            self.assertEqual(deploys.group_gpu_ids(name), [])
            self.assertFalse(deploys.pod_supports_gpu(name))

    def test_scheduler_group_has_gpu(self):
        self.assertTrue(scheduler.group_has_gpu("g"))
        self.assertFalse(scheduler.group_has_gpu("c"))
        self.assertFalse(scheduler.group_has_gpu("w"))

    def test_unknown_group_keeps_legacy_behaviour(self):
        # Pod already gone / lookup failed: don't silently disable placement.
        self.assertTrue(scheduler.group_has_gpu("missing"))
        self.assertTrue(deploys.pod_supports_gpu("missing"))
        self.assertEqual(deploys.group_gpu_ids("missing"), [])

    def test_unreadable_state_keeps_legacy_behaviour(self):
        def boom():
            raise RuntimeError("state unreadable")
        patch_state(self, boom)
        self.assertTrue(deploys.pod_supports_gpu("c"))
        self.assertTrue(scheduler.group_has_gpu("c"))


class Sanitize(unittest.TestCase):
    def setUp(self):
        patch_state(self, {"g": GPU_POD, "c": CPU_POD})

    def test_cpu_pod_normalises_gpu_only_fields(self):
        fields = {"kind": "train", "gpu": "2", "vram": "8000",
                  "env": {"DEFER_OK": "true", "OTHER": "keep"},
                  "health": "/health"}
        self.assertEqual(deploys.sanitize_gpu_fields("c", fields), {
            "kind": "serve", "gpu": "", "vram": "",
            "env": {"OTHER": "keep"}, "health": "/health"})

    def test_input_not_mutated(self):
        fields = {"kind": "train", "gpu": "1", "env": {"DEFER_OK": "true"}}
        deploys.sanitize_gpu_fields("c", fields)
        self.assertEqual(fields, {"kind": "train", "gpu": "1",
                                  "env": {"DEFER_OK": "true"}})

    def test_absent_keys_stay_absent(self):
        self.assertEqual(deploys.sanitize_gpu_fields("c", {"mode": "oneshot"}),
                         {"mode": "oneshot"})

    def test_gpu_pod_untouched(self):
        fields = {"kind": "train", "gpu": "2", "vram": "8000",
                  "env": {"DEFER_OK": "true"}}
        self.assertEqual(deploys.sanitize_gpu_fields("g", fields), fields)

    def test_normalized_flag(self):
        self.assertTrue(deploys.gpu_fields_normalized("c", {"gpu": "2"}))
        self.assertTrue(deploys.gpu_fields_normalized(
            "c", {"kind": "train", "env": {"DEFER_OK": "true"}}))
        self.assertFalse(deploys.gpu_fields_normalized("c", {"gpu": "", "kind": "serve"}))
        self.assertFalse(deploys.gpu_fields_normalized("g", {"kind": "train",
                                                             "gpu": "2"}))


class Store(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        p = mock.patch.object(deploys, "STATE_FILE",
                              os.path.join(tmp.name, "deploys.json"))
        p.start()
        self.addCleanup(p.stop)
        patch_state(self, {"g": GPU_POD, "c": CPU_POD})

    def test_add_on_cpu_pod_drops_gpu_settings(self):
        d = deploys.add("c", {"name": "web", "repo": "", "kind": "train",
                              "gpu": "2", "vram": "8000",
                              "env": {"DEFER_OK": "true", "KEEP": "1"}})
        self.assertEqual(d["kind"], "serve")
        self.assertEqual(d["gpu"], "")
        self.assertEqual(d["vram"], "")
        self.assertEqual(d["env"], {"KEEP": "1"})
        again = deploys.get("c", d["id"])
        self.assertEqual(again["kind"], "serve")
        self.assertEqual(again["env"], {"KEEP": "1"})

    def test_add_on_gpu_pod_keeps_gpu_settings(self):
        d = deploys.add("g", {"name": "train", "repo": "", "kind": "train",
                              "gpu": "2", "vram": "8000",
                              "env": {"DEFER_OK": "true"}})
        self.assertEqual(d["kind"], "train")
        self.assertEqual(d["gpu"], "2")
        self.assertEqual(d["env"], {"DEFER_OK": "true"})

    def test_update_normalises_legacy_cpu_record(self):
        d = deploys.add("c", {"name": "legacy", "repo": ""})
        deploys.update("c", d["id"], kind="train", gpu="2",
                       env={"DEFER_OK": "true"})
        again = deploys.get("c", d["id"])
        self.assertEqual(again["kind"], "serve")
        self.assertEqual(again["gpu"], "")
        self.assertEqual(again["env"], {})

    def test_update_presence_driven_on_gpu_pod(self):
        d = deploys.add("g", {"name": "srv", "repo": "", "gpu": "2"})
        deploys.update("g", d["id"], health="/health")
        again = deploys.get("g", d["id"])
        self.assertEqual(again["gpu"], "2")          # untouched
        self.assertEqual(again["health"], "/health")


class Placement(unittest.TestCase):
    def setUp(self):
        patch_state(self, {"g": GPU_POD, "c": CPU_POD})

    def test_gpu_for_deploy_none_on_cpu_pod(self):
        dep = {"id": "d1", "kind": "train", "gpu": "2", "vram": "8000"}
        with mock.patch.object(scheduler, "place_train") as pt, \
                mock.patch.object(scheduler, "place_serve") as ps, \
                mock.patch.object(scheduler, "sample") as sm:
            self.assertIsNone(scheduler.gpu_for_deploy(dep, "c"))
        pt.assert_not_called()
        ps.assert_not_called()
        sm.assert_not_called()

    def test_gpu_for_deploy_still_places_on_gpu_pod(self):
        dep = {"id": "d1", "kind": "train", "vram": "8000"}
        with mock.patch.object(scheduler, "place_train",
                               return_value=1) as pt:
            self.assertEqual(scheduler.gpu_for_deploy(dep, "g"), 1)
        pt.assert_called_once()


if __name__ == "__main__":
    unittest.main()
