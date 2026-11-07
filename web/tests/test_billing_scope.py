"""Billing *scope* + permission tightening + low-balance alert re-arming.

Three口径 pinned down here, all of them「一改就静默跑偏」的地方:

1. **计费范围 = 黑名单**：组上 ``internal=True`` → 免计费（结算跳过、不提醒），
   与账户行 ``billable`` 无关（内部组即使没有账户行也不扣）。
2. **权限收口**：``user`` 只保留「自己组 + 终端 + 只读主机/存储/共享 + 账单」，
   ``guest`` 只剩 ``group.view`` —— 平台内部面（``infra.host`` 命令类、
   ``infra.db.read``、``ops.threat``、``dev.*``）不再下发。
3. **低余额提醒**：事件键带滚动窗口号 —— 同一窗口重复调用只落一条，
   跨窗口（含「充值后再次欠费」）会重新提醒；旧的固定键一辈子只报一次。

不加载 app.py / DB / 生产状态：flat 模块及其依赖全部 stub。
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import types
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


# ── 1. groups.internal / set_internal ────────────────────────────────
class InternalGroups(unittest.TestCase):
    """``groups`` 模块在临时 YATTERRA_ROOT 下跑，绝不碰生产 groups.json。"""

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
        self.siteconf = load("siteconf_fresh", "siteconf.py")
        self.mods = patch.dict(sys.modules, {
            "siteconf": self.siteconf,
            "users": MagicMock(), "audit": MagicMock(), "req_estimate": MagicMock(),
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.groups = load("groups_under_test", "groups.py")
        self.groups.all_pod_statuses = lambda: {}   # 不打 kubectl

    def _write_state(self, groups_map):
        path = Path(self.groups.STATE_FILE)
        path.write_text(json.dumps({"groups": groups_map}))

    def test_set_internal_roundtrip(self):
        self._write_state({"a": {"name": "a", "index": 0},
                           "b": {"name": "b", "index": 1}})
        self.assertFalse(self.groups.internal_groups())

        self.assertTrue(self.groups.set_internal("a", True))
        self.assertEqual(self.groups.internal_groups(), {"a"})
        self.assertTrue(json.loads(Path(self.groups.STATE_FILE).read_text())
                        ["groups"]["a"]["internal"])

        self.groups.set_internal("a", False)
        self.assertFalse(self.groups.internal_groups())
        self.assertFalse(json.loads(Path(self.groups.STATE_FILE).read_text())
                         ["groups"]["a"]["internal"])

    def test_unknown_group_rejected(self):
        self._write_state({"a": {"name": "a", "index": 0}})
        with self.assertRaises(ValueError):
            self.groups.set_internal("nope", True)

    def test_legacy_group_without_flag_defaults_external(self):
        """旧 groups.json 没有 internal 字段 → list_groups 补 False（可计费）。"""
        self._write_state({"legacy": {"name": "legacy", "index": 0}})
        listed, _state = self.groups.list_groups()
        self.assertEqual(listed[0]["internal"], False)
        self.assertEqual(self.groups.internal_groups(), set())

    def test_internal_groups_survives_corrupt_state(self):
        Path(self.groups.STATE_FILE).write_text("{ not json")
        self.assertEqual(self.groups.internal_groups(), set())


# ── 2. billing_settle 跳过内部组 ─────────────────────────────────────
class SettleSkipsInternal(unittest.TestCase):
    def setUp(self):
        self.now_hour = int(time.time() // 3600) * 3600
        self.billing_store = MagicMock()
        self.billing_store.get_prices.return_value = {}
        self.billing_store.get_account.return_value = None
        self.billing_store.charge_period.return_value = 7   # 一行 = 7 分
        self.billing_store.STATUS_ACTIVE = "active"
        self.billing_store.STATUS_CLOSED = "closed"
        self.billing_store.STATUS_SUSPENDED = "suspended"
        self.billing_store.balance_ratio.side_effect = lambda acct: None
        self.billing_store.list_accounts.return_value = []
        self.usage = MagicMock()
        self.usage.HOUR = 3600
        self.usage.hour_of.side_effect = lambda t: int(t // 3600) * 3600
        self.store = MagicMock()
        self.store.summary.return_value = ({}, [
            {"group_name": "internal-g", "core_hours": 1.0},
            {"group_name": "ext-g", "core_hours": 1.0},
        ])
        self.usage.UsageStore.return_value = self.store
        self.billing_core = MagicMock()
        self.billing_core.breakdown.return_value = [{"cost_cents": 7}]
        self.groups = MagicMock()
        self.groups.internal_groups.return_value = {"internal-g"}
        self.pwa = MagicMock()

        self.mods = patch.dict(sys.modules, {
            "logutil": MagicMock(), "siteconf": MagicMock(), "usage_store": self.usage,
            "billing_store": self.billing_store, "billing_core": self.billing_core,
            "groups": self.groups, "pwa_alerts": self.pwa,
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.bs = load("billing_settle_under_test", "billing_settle.py")

    def test_settle_hours_skips_internal_group(self):
        res = self.bs.settle_hours(self.now_hour - 3600, self.now_hour)
        charged = {c.args[0] for c in self.billing_store.charge_period.call_args_list}
        self.assertEqual(charged, {"ext-g"})
        self.assertEqual(res["groups"], 1)
        self.assertEqual(res["charged_cents"], 7)

    def test_settle_dry_run_also_skips_internal(self):
        res = self.bs.settle_hours(self.now_hour - 3600, self.now_hour, dry_run=True)
        self.billing_store.charge_period.assert_not_called()
        self.assertEqual(res["charged_cents"], 7)   # 只有外部组那一份

    def test_enforce_skips_internal_group(self):
        self.billing_store.list_accounts.return_value = [
            {"group_name": "internal-g", "billable": 1, "balance_cents": -100,
             "status": "active", "warn_ratio": 0.2},
            {"group_name": "ext-g", "billable": 1, "balance_cents": -100,
             "status": "active", "warn_ratio": 0.2},
        ]
        out = self.bs.enforce()
        self.assertEqual(out["warned"], ["ext-g"])
        keys = [c.args[0] for c in self.pwa.notify_event.call_args_list]
        self.assertTrue(all("ext-g" in k for k in keys), keys)


# ── 2b. enforce: 到 0 自动停机（部署默认开） ──────────────────────────
class EnforceAutoSuspend(unittest.TestCase):
    """额度 ≤0 连续 ``BELOW_ZERO_RUNS`` 次 → 停机；显式关掉则只提醒。"""

    def setUp(self):
        self.billing_store = MagicMock()
        self.billing_store.STATUS_ACTIVE = "active"
        self.billing_store.STATUS_SUSPENDED = "suspended"
        self.billing_store.STATUS_CLOSED = "closed"
        self.billing_store.balance_ratio.side_effect = lambda acct: None
        self.groups = MagicMock()
        self.groups.internal_groups.return_value = set()
        self.mods = patch.dict(sys.modules, {
            "logutil": MagicMock(), "siteconf": MagicMock(),
            "billing_store": self.billing_store, "billing_core": MagicMock(),
            "groups": self.groups, "pwa_alerts": MagicMock(),
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.bs = load("billing_settle_suspend", "billing_settle.py")
        self.bs._BELOW_ZERO.clear()
        self.rows = [{"group_name": "ext-g", "billable": 1, "balance_cents": -1,
                      "status": "active", "warn_ratio": 0.2}]

    def test_suspends_at_zero_after_n_runs(self):
        for _ in range(self.bs.BELOW_ZERO_RUNS - 1):
            out = self.bs.enforce(self.rows)
            self.assertEqual(out["suspended"], [], "提前停机")
        out = self.bs.enforce(self.rows)
        self.assertEqual(out["suspended"], ["ext-g"])
        self.billing_store.set_account.assert_called_once_with(
            "ext-g", status=self.billing_store.STATUS_SUSPENDED)
        # 欠费会先提醒(severe)，再停机
        self.assertIn("ext-g", out["warned"])

    def test_disabled_is_warn_only(self):
        env = patch.dict(os.environ, {"YATTERRA_BILLING_AUTO_SUSPEND": "0"})
        env.start()
        self.addCleanup(env.stop)
        for _ in range(self.bs.BELOW_ZERO_RUNS + 2):
            out = self.bs.enforce(self.rows)
        self.assertEqual(out["suspended"], [])
        self.billing_store.set_account.assert_not_called()
        self.assertIn("ext-g", out["warned"])

    def test_topup_resets_the_counter(self):
        self.bs.enforce(self.rows)          # 欠费第 1 次
        self.assertEqual(self.bs._BELOW_ZERO.get("ext-g"), 1)
        paid = [dict(self.rows[0], balance_cents=500)]
        self.bs.enforce(paid)               # 有余额 → 计数清零
        self.assertNotIn("ext-g", self.bs._BELOW_ZERO)


# ── 3. 低余额提醒：滚动窗口 ──────────────────────────────────────────
class LowAlertWindow(unittest.TestCase):
    def setUp(self):
        self.pwa = MagicMock()
        self.mods = patch.dict(sys.modules, {
            "logutil": MagicMock(), "siteconf": MagicMock(), "usage_store": MagicMock(),
            "pwa_alerts": self.pwa,
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.bs = load("billing_settle_win", "billing_settle.py")
        self.bs.LOW_COOLDOWN_S = 60

    def _key(self, at):
        with patch.object(time, "time", lambda: at):
            self.bs._notify_low("g1", -50, None, severe=True)
        return self.pwa.notify_event.call_args.args[0]

    def test_same_window_key_is_stable(self):
        base = 1_700_000_000
        self.assertEqual(self._key(base), self._key(base + 5))

    def test_next_window_rearms(self):
        base = 1_700_000_000
        self.assertNotEqual(self._key(base), self._key(base + 60))

    def test_state_is_part_of_key_and_url_points_at_billing(self):
        self._key(1_700_000_000)
        kw = self.pwa.notify_event.call_args.kwargs
        self.assertIn(":zero", self.pwa.notify_event.call_args.args[0])
        self.assertEqual(kw["url"], "/billing?group=g1")
        self.assertEqual(kw["kind"], "billing-low")


# ── 4. 权限收口 ──────────────────────────────────────────────────────
class RolePermsTightened(unittest.TestCase):
    def setUp(self):
        self.users = load("users_under_test", "users.py")

    def _perms(self, role):
        return self.users.expanded_perms({"role": role})

    def test_user_keeps_tenant_readonly_surface(self):
        p = self._perms("user")
        for keep in ("group.create", "group.view", "group.terminal",
                     "infra.host.view", "infra.storage.read", "ops.shared.read",
                     "billing.pay"):
            self.assertIn(keep, p)

    def test_user_can_allocate_to_pods(self):
        """分配额度 = 普通成员的自助动作（花自己钱包的钱）→ user 档必须有。"""
        for role in ("user", "admin", "super"):
            self.assertIn("billing.allocate", self._perms(role), role)

    def test_guest_cannot_allocate(self):
        self.assertNotIn("billing.allocate", self._perms("guest"))

    def test_reclaim_stays_admin_only(self):
        """收回额度只有管理员能（user 无 billing.account）。"""
        self.assertNotIn("billing.account", self._perms("user"))
        self.assertIn("billing.account", self._perms("admin"))

    def test_user_loses_platform_internal_surface(self):
        p = self._perms("user")
        for gone in ("infra.host", "infra.db", "infra.db.read", "ops.threat",
                     "dev.agent", "dev.llm"):
            self.assertNotIn(gone, p)

    def test_guest_only_group_view(self):
        self.assertEqual(self._perms("guest"), {"group.view"})

    def test_admin_and_super_unchanged(self):
        for role in ("admin", "super"):
            p = self._perms(role)
            for perm in ("infra.host", "ops.threat", "dev.agent"):
                self.assertIn(perm, p)


# ── 5. 洞察作用域：平台级页面只对 admin ──────────────────────────────
class InsightPageScope(unittest.TestCase):
    def setUp(self):
        deps = ["llm", "siteconf", "agent", "ai_service", "insight", "users",
                "groups", "pwa_alerts", "audit", "billing_store", "usage_store"]
        self.mods = patch.dict(sys.modules, {n: MagicMock() for n in deps})
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.ai = load("ai_api_under_test", "api/ai.py")

    def test_platform_pages_are_admin_only(self):
        for page in ("dashboard", "gpu", "host", "infra", "fleet"):
            self.assertEqual(self.ai.INSIGHT_PAGE_PERMS.get(page), "admin.users", page)

    def test_pod_and_storage_stay_tenant_scoped(self):
        self.assertEqual(self.ai.INSIGHT_PAGE_PERMS.get("pod"), "group.view")
        self.assertEqual(self.ai.INSIGHT_PAGE_PERMS.get("storage"), "infra.storage.read")


if __name__ == "__main__":
    unittest.main()
