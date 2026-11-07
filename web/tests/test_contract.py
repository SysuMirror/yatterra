"""contract: parsing, defaults, precedence, the critical lock, never-raises.

Group dicts are passed directly so no production state is read.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contract


class ParseBool(unittest.TestCase):
    def test_truth_table(self):
        for v in ("1", "true", "TRUE", "Yes", "on", "y", 1, True):
            self.assertIs(contract.parse_bool(v), True, v)
        for v in ("0", "false", "no", "off", "", None, 0, False, "banana"):
            self.assertIs(contract.parse_bool(v), False, v)


class ParseDeadline(unittest.TestCase):
    NOW = 1_700_000_000

    def test_epoch_forms(self):
        self.assertEqual(contract.parse_deadline(1_800_000_000, self.NOW), 1_800_000_000)
        self.assertEqual(contract.parse_deadline("1800000000", self.NOW), 1_800_000_000)
        self.assertEqual(contract.parse_deadline(1800000000.7, self.NOW), 1_800_000_000)

    def test_relative_forms(self):
        self.assertEqual(contract.parse_deadline("+90s", self.NOW), self.NOW + 90)
        self.assertEqual(contract.parse_deadline("+1h", self.NOW), self.NOW + 3600)
        self.assertEqual(contract.parse_deadline("+2m", self.NOW), self.NOW + 120)
        self.assertEqual(contract.parse_deadline("+1d", self.NOW), self.NOW + 86400)
        self.assertEqual(contract.parse_deadline("+1h30m", self.NOW), self.NOW + 5400)
        self.assertEqual(contract.parse_deadline("+3600", self.NOW), self.NOW + 3600)

    def test_iso8601(self):
        self.assertEqual(contract.parse_deadline("2030-01-01T00:00:00Z", self.NOW),
                         1893456000)
        self.assertEqual(contract.parse_deadline("2030-01-01T00:00:00+00:00", self.NOW),
                         1893456000)

    def test_invalid_is_none(self):
        for v in (None, "", "+", "+x", "tomorrow", "not-a-date", True):
            self.assertIsNone(contract.parse_deadline(v, self.NOW), repr(v))


class Defaults(unittest.TestCase):
    def test_kind_defaults(self):
        self.assertEqual(contract.derive_defaults("serve"),
                         {"defer_ok": False, "preempt_ok": False, "deadline": None})
        self.assertEqual(contract.derive_defaults("train"),
                         {"defer_ok": False, "preempt_ok": True, "deadline": None})
        self.assertEqual(contract.derive_defaults(None),
                         {"defer_ok": False, "preempt_ok": False, "deadline": None})

    def test_critical_locks_preempt_off(self):
        self.assertFalse(contract.derive_defaults("train", "critical")["preempt_ok"])


class ContractFor(unittest.TestCase):
    NOW = 1_700_000_000

    def test_default_no_env(self):
        c = contract.contract_for({"name": "g"}, {"kind": "train"}, self.NOW)
        self.assertEqual(c, {"defer_ok": False, "preempt_ok": True, "deadline": None})

    def test_group_env_then_dep_overrides(self):
        g = {"env": {"DEFER_OK": "1", "DEADLINE": "+1h"}}
        c = contract.contract_for(g, {"kind": "serve"}, self.NOW)
        self.assertTrue(c["defer_ok"])
        self.assertEqual(c["deadline"], self.NOW + 3600)
        self.assertFalse(c["preempt_ok"])  # serve default

        dep = {"kind": "serve", "env": {"DEFER_OK": "0", "PREEMPT_OK": "1"}}
        c2 = contract.contract_for(g, dep, self.NOW)
        self.assertFalse(c2["defer_ok"])   # dep wins over group
        self.assertTrue(c2["preempt_ok"])

    def test_dep_first_class_field_wins(self):
        dep = {"kind": "serve", "defer_ok": True, "deadline": 123}
        c = contract.contract_for({"env": {"DEFER_OK": "0"}}, dep, self.NOW)
        self.assertTrue(c["defer_ok"])
        self.assertEqual(c["deadline"], 123)

    def test_critical_cannot_be_raised_by_dep_env(self):
        g = {"priority": "critical"}
        c = contract.contract_for(g, {"kind": "train", "env": {"PREEMPT_OK": "1"}},
                                  self.NOW)
        self.assertFalse(c["preempt_ok"])

    def test_group_name_read_failure_falls_back_to_defaults(self):
        with mock.patch.dict(sys.modules, {"groups": mock.MagicMock(
                load_state=mock.Mock(side_effect=RuntimeError("boom")))}):
            c = contract.contract_for("somegroup", {"kind": "train"}, self.NOW)
        self.assertEqual(c, {"defer_ok": False, "preempt_ok": True, "deadline": None})

    def test_helpers(self):
        g = {"env": {"DEFER_OK": "true", "PREEMPT_OK": "false", "DEADLINE": "+60s"}}
        self.assertTrue(contract.deferable(g, {"kind": "train"}, self.NOW))
        self.assertFalse(contract.preemptable(g, {"kind": "train"}, self.NOW))
        self.assertEqual(contract.deadline_ts(g, {"kind": "train"}, self.NOW),
                         self.NOW + 60)


if __name__ == "__main__":
    unittest.main()
