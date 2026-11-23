"""quota: 活动资源上限（UniSSO 用户 CPU≤2 / 内存≤2Gi / 存储≤5Gi / 无 GPU）。

纯函数测试，无 DB / 无 app.py。``is_unisso`` 只在用户名不以 ``uni_`` 开头时才查
身份表，这里把 ``users`` 整个 stub 掉。
"""
import importlib.util
import sys
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


class Quota(unittest.TestCase):
    def setUp(self):
        self.users = MagicMock()
        self.users.list_identities.return_value = []
        self.users.get_user.return_value = None
        mods = patch.dict(sys.modules, {"users": self.users})
        mods.start()
        self.addCleanup(mods.stop)
        self.q = load("quota_under_test", "quota.py")
        self.uni = {"username": "uni_42", "role": "user"}
        self.local = {"username": "bob", "role": "user"}
        self.admin = {"username": "uni_1", "role": "admin"}

    # ── scoped ──────────────────────────────────────────────────
    def test_uni_user_is_scoped(self):
        self.assertTrue(self.q.scoped(self.uni))

    def test_local_user_not_scoped(self):
        self.assertFalse(self.q.scoped(self.local))

    def test_identity_table_counts_even_without_prefix(self):
        self.users.list_identities.return_value = [{"provider": "unisso"}]
        self.assertTrue(self.q.scoped({"username": "someone", "role": "user"}))
        self.users.list_identities.return_value = [{"provider": "ssemarket"}]
        self.assertFalse(self.q.scoped({"username": "someone", "role": "user"}))

    def test_admin_and_super_exempt(self):
        self.assertFalse(self.q.scoped({"username": "uni_1", "role": "admin"}))
        self.assertFalse(self.q.scoped({"username": "uni_2", "role": "super"}))

    def test_username_string_is_accepted(self):
        self.assertTrue(self.q.scoped("uni_7"))
        self.assertFalse(self.q.scoped("alice"))   # get_user → None → role user, no prefix

    # ── validate_create ─────────────────────────────────────────
    def test_gpu_rejected(self):
        with self.assertRaises(self.q.QuotaError):
            self.q.validate_create(self.uni, gpus=[0])

    def test_cpu_over_cap_rejected(self):
        with self.assertRaises(self.q.QuotaError):
            self.q.validate_create(self.uni, cpu=3)

    def test_mem_over_cap_rejected(self):
        with self.assertRaises(self.q.QuotaError):
            self.q.validate_create(self.uni, mem="4Gi")

    def test_storage_over_cap_rejected(self):
        with self.assertRaises(self.q.QuotaError):
            self.q.validate_create(self.uni, storage="10Gi")

    def test_boundary_values_pass(self):
        self.q.validate_create(self.uni, cpu=2, mem="2Gi", storage="5Gi")  # 不抛

    def test_admin_and_local_not_limited(self):
        for u in (self.admin, self.local):
            self.q.validate_create(u, cpu=64, mem="256Gi", storage="500Gi", gpus=[0, 1])

    # ── clamp_resize ────────────────────────────────────────────
    def test_clamp_pulls_each_dimension_down(self):
        cpu, mem, sto, clamped = self.q.clamp_resize(self.uni, 8, "8Gi", "20Gi")
        self.assertEqual((cpu, mem, sto), (2, "2Gi", "5Gi"))
        self.assertEqual(clamped, ["cpu", "mem", "storage"])

    def test_clamp_leaves_in_range_values(self):
        cpu, mem, sto, clamped = self.q.clamp_resize(self.uni, 1, "1Gi", "5Gi")
        self.assertEqual((cpu, mem, sto), (1, "1Gi", "5Gi"))
        self.assertEqual(clamped, [])

    def test_clamp_is_noop_for_others(self):
        cpu, mem, sto, clamped = self.q.clamp_resize(self.local, 8, "8Gi", "20Gi")
        self.assertEqual((cpu, mem, sto), (8, "8Gi", "20Gi"))
        self.assertEqual(clamped, [])

    def test_clamp_ignores_none_dims(self):
        cpu, mem, sto, clamped = self.q.clamp_resize(self.uni, None, None, "9Gi")
        self.assertIsNone(cpu)
        self.assertIsNone(mem)
        self.assertEqual(sto, "5Gi")
        self.assertEqual(clamped, ["storage"])

    # ── limits / parse ──────────────────────────────────────────
    def test_limits_payload(self):
        lim = self.q.limits(self.uni)
        self.assertTrue(lim["scoped"])
        self.assertEqual(lim["caps"]["cpu"], 2)
        self.assertEqual(lim["caps"]["mem"], "2Gi")
        self.assertEqual(lim["caps"]["storage"], "5Gi")
        self.assertFalse(lim["caps"]["gpu_allowed"])
        self.assertFalse(self.q.limits(self.local)["scoped"])

    def test_parse_gi(self):
        self.assertEqual(self.q.parse_gi("2Gi"), 2.0)
        self.assertEqual(self.q.parse_gi("512Mi"), 0.5)
        self.assertEqual(self.q.parse_gi("2"), 2.0)
        self.assertEqual(self.q.parse_gi("1Ti"), 1024.0)
        self.assertIsNone(self.q.parse_gi(""))
        self.assertIsNone(self.q.parse_gi("abc"))
        self.assertIsNone(self.q.parse_gi(None))


if __name__ == "__main__":
    unittest.main()
