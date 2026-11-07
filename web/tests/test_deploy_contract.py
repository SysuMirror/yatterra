"""P1-c flexibility contract surfaced through the deploy API/UI path.

Covers the two new seams added for the frontend selector:

- ``api.pods._contract_env`` — the request-body → dep ``env`` translator the UI
  now posts to ``POST /pods/<name>/deploys`` (train only).
- ``deploys.add`` persisting that ``env`` so ``contract._sources`` can read it.

No production file is touched: ``deploys.STATE_FILE`` points at a temp dir and
``contract._group_dict`` is stubbed (never calls ``groups.load_state``).
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contract
import deploys
import api.pods as pods_api


class ContractEnv(unittest.TestCase):
    def test_train_only(self):
        self.assertEqual(pods_api._contract_env({}, "serve"), {})
        self.assertEqual(pods_api._contract_env({"defer_ok": True}, "serve"), {})
        self.assertEqual(pods_api._contract_env({}, ""), {})

    def test_bool_and_string_coercion(self):
        env = pods_api._contract_env(
            {"defer_ok": True, "preempt_ok": False, "deadline": "  +2h ",
             "est_duration_s": "7200", "deadline_kind": "hard"}, "train")
        self.assertEqual(env, {"DEFER_OK": "true", "PREEMPT_OK": "false",
                               "DEADLINE": "+2h", "EST_DURATION_S": "7200",
                               "DEADLINE_KIND": "hard"})

    def test_empty_values_skipped_false_bool_kept(self):
        self.assertEqual(
            pods_api._contract_env({"defer_ok": False, "deadline": "   ",
                                    "est_duration_s": ""}, "train"),
            {"DEFER_OK": "false"})

    def test_unknown_keys_ignored(self):
        self.assertEqual(pods_api._contract_env({"vram": "8000"}, "train"), {})


class RoundTrip(unittest.TestCase):
    """UI body → dep env → contract.contract_for (the scheduler's read)."""

    def setUp(self):
        p = mock.patch.object(contract, "_group_dict", lambda g: {})
        p.start()
        self.addCleanup(p.stop)

    def test_defer_and_deadline(self):
        env = pods_api._contract_env(
            {"defer_ok": True, "deadline": "+2h", "deadline_kind": "hard"}, "train")
        dep = {"id": "d1", "kind": "train", "env": env}
        c = contract.contract_for("g", dep, now=1_700_000_000)
        self.assertTrue(c["defer_ok"])
        self.assertTrue(c["preempt_ok"])           # train default
        self.assertGreater(c["deadline"], 1_700_000_000)

    def test_default_off_when_no_keys(self):
        dep = {"id": "d1", "kind": "train", "env": pods_api._contract_env({}, "train")}
        c = contract.contract_for("g", dep)
        self.assertFalse(c["defer_ok"])
        self.assertIsNone(c["deadline"])


class Persistence(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        p = mock.patch.object(deploys, "STATE_FILE",
                              os.path.join(tmp.name, "deploys.json"))
        p.start()
        self.addCleanup(p.stop)

    def test_add_persists_env(self):
        d = deploys.add("g", {"name": "x", "repo": "", "kind": "train",
                              "env": {"DEFER_OK": "true"}})
        self.assertEqual(d["env"], {"DEFER_OK": "true"})
        self.assertEqual(deploys.get("g", d["id"])["env"], {"DEFER_OK": "true"})

    def test_add_defaults_env_to_empty(self):
        d = deploys.add("g", {"name": "y", "repo": "", "kind": "serve"})
        self.assertEqual(d["env"], {})


if __name__ == "__main__":
    unittest.main()
