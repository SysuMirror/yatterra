"""Pod tag: ``groups.norm_tag`` / ``groups.set_tag``.

标签只作元数据（活动分组、按 tag 批量充值用）：不进 manifest，不触发 rollout。
``groups`` 在临时 ``YATTERRA_ROOT`` 下加载，绝不碰生产 ``groups.json``
（仿 test_billing_scope.InternalGroups）。
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TagGroups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"YATTERRA_ROOT": self.tmp.name,
                                      "YATTERRA_WEB_DIR": str(ROOT)})
        env.start()
        self.addCleanup(env.stop)
        # siteconf 在 import 时固化 ROOT → 必须重新加载
        for mod in ("siteconf", "groups"):
            sys.modules.pop(mod, None)
        self.siteconf = load("siteconf_tag", "siteconf.py")
        self.audit = MagicMock()
        self.mods = patch.dict(sys.modules, {
            "siteconf": self.siteconf, "users": MagicMock(),
            "audit": self.audit, "req_estimate": MagicMock(),
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.groups = load("groups_tag", "groups.py")

    def _write_state(self, groups_map):
        Path(self.groups.STATE_FILE).write_text(json.dumps({"groups": groups_map}))

    def _tag_of(self, name):
        return json.loads(Path(self.groups.STATE_FILE).read_text())["groups"][name].get("tag")

    def test_set_tag_roundtrip(self):
        self._write_state({"a": {"name": "a", "index": 0}})
        self.assertEqual(self.groups.set_tag("a", "活动X"), "活动X")
        self.assertEqual(self._tag_of("a"), "活动X")
        self.audit.record.assert_called()          # 留痕

    def test_tag_can_be_changed(self):
        self._write_state({"a": {"name": "a", "index": 0}})
        self.groups.set_tag("a", "第一批")
        self.assertEqual(self.groups.set_tag("a", "第二批"), "第二批")
        self.assertEqual(self._tag_of("a"), "第二批")

    def test_tag_can_be_cleared(self):
        self._write_state({"a": {"name": "a", "index": 0, "tag": "旧"}})
        self.assertIsNone(self.groups.set_tag("a", ""))
        self.assertIsNone(self._tag_of("a"))
        self.groups.set_tag("a", "又设")
        self.assertIsNone(self.groups.set_tag("a", None))
        self.assertIsNone(self._tag_of("a"))

    def test_unknown_group_rejected(self):
        self._write_state({"a": {"name": "a", "index": 0}})
        with self.assertRaises(ValueError):
            self.groups.set_tag("nope", "x")

    def test_existing_tag_survives_other_edits(self):
        """只动目标组的 tag，不波及别的组。"""
        self._write_state({"a": {"name": "a", "index": 0, "tag": "A"},
                           "b": {"name": "b", "index": 1, "tag": "B"}})
        self.groups.set_tag("a", "A2")
        self.assertEqual(self._tag_of("b"), "B")


class NormTag(unittest.TestCase):
    """``norm_tag`` 是纯函数，但随 ``groups`` 一起加载。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {"YATTERRA_ROOT": self.tmp.name,
                                      "YATTERRA_WEB_DIR": str(ROOT)})
        env.start()
        self.addCleanup(env.stop)
        for mod in ("siteconf", "groups"):
            sys.modules.pop(mod, None)
        self.siteconf = load("siteconf_normtag", "siteconf.py")
        self.mods = patch.dict(sys.modules, {
            "siteconf": self.siteconf, "users": MagicMock(),
            "audit": MagicMock(), "req_estimate": MagicMock(),
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.groups = load("groups_normtag", "groups.py")

    def test_strips_and_normalizes(self):
        self.assertEqual(self.groups.norm_tag("  活动X  "), "活动X")

    def test_blank_is_none(self):
        self.assertIsNone(self.groups.norm_tag(""))
        self.assertIsNone(self.groups.norm_tag("   "))
        self.assertIsNone(self.groups.norm_tag(None))

    def test_allows_cjk_dash_dot_underscore_space(self):
        for ok in ("活动-1", "2026 春", "a.b_c-1", "第一期"):
            self.assertEqual(self.groups.norm_tag(ok), ok)

    def test_rejects_overlong(self):
        with self.assertRaises(ValueError):
            self.groups.norm_tag("x" * 65)

    def test_rejects_illegal_chars(self):
        for bad in ("a/b", "a;b", "a\nb", "a$b"):
            with self.assertRaises(ValueError):
                self.groups.norm_tag(bad)

    def test_alias_bound(self):
        self.assertIs(self.groups._norm_tag, self.groups.norm_tag)


if __name__ == "__main__":
    unittest.main()
