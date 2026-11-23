"""按 tag 给 Pod 发额度：``billing_store.grant`` 幂等 + ``/admin/grant-by-tag`` 命中规则。

两部分：

1. ``billing_store.grant`` —— 用 fake cursor 模拟 SQL（同 test_billing_store），
   验证「同一 token 第二次发放返回 None（不重复加钱）」「不同 token 累加」
   「set_credit_limit 抬到发放后余额」「非正金额拒绝」。
2. ``/api/billing/admin/grant-by-tag`` + ``/admin/tags`` —— 独立加载蓝图、stub
   依赖（同 test_wallet_api），验证只命中「tag 匹配、非内部、billable 非 0」的组、
   每组一个独立 token、鉴权 admin-only。
"""
import hashlib
import importlib.util
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import billing_store as bs


# ── 1. billing_store.grant ───────────────────────────────────────
class _GrantCursor:
    """只实现 grant 走到的几条 SQL。"""

    def __init__(self, m):
        self.m = m
        self.rowcount = 0
        self._one = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, args=()):
        s = " ".join(sql.split())
        self.rowcount = 0
        self._one = None
        if s.startswith("INSERT IGNORE INTO billing_ledger"):
            group, kind, amount, token, note, actor = args
            if token in self.m["tokens"]:
                return                      # rowcount 保持 0 → 幂等
            self.m["tokens"].add(token)
            self.m["id"] += 1
            self.m["ledger"].append({"id": self.m["id"], "group_name": group,
                                     "kind": kind, "amount_cents": amount,
                                     "token": token, "balance_after": None})
            self.rowcount = 1
        elif "balance_cents = balance_cents + %s" in s:
            delta, group = args
            self.m["bal"][group] = self.m["bal"].get(group, 0) + delta
            self.rowcount = 1
        elif s.startswith("SELECT balance_cents FROM billing_accounts"):
            (group,) = args
            self._one = {"balance_cents": self.m["bal"].get(group, 0)}
        elif s.startswith("UPDATE billing_ledger SET balance_after="):
            bal, token = args
            for row in reversed(self.m["ledger"]):
                if row["token"] == token:
                    row["balance_after"] = bal
                    break
            self.rowcount = 1
        elif s.startswith("UPDATE billing_accounts SET credit_limit_cents=%s"):
            val, group = args
            self.m["limit"][group] = val
            self.rowcount = 1
        else:  # pragma: no cover
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one

    def fetchall(self):
        return []


class _GrantConn:
    def __init__(self, m):
        self.m = m

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _GrantCursor(self.m)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class GrantMoney(unittest.TestCase):
    def setUp(self):
        self.model = {"ledger": [], "bal": {}, "limit": {}, "tokens": set(), "id": 0}
        self.conn = _GrantConn(self.model)

        @contextmanager
        def fake_tx():
            yield self.conn

        for p in [
            mock.patch.object(bs, "ensure_schema", lambda: None),
            mock.patch.object(bs, "ensure_account", lambda g, **k: {"group_name": g}),
            mock.patch.object(bs, "tx", fake_tx),
            mock.patch.object(bs.users, "_conn", lambda: self.conn),
        ]:
            p.start()
            self.addCleanup(p.stop)

    def test_grant_credits_once(self):
        self.assertEqual(bs.grant("g", 500, "grant:b1:x"), 500)
        self.assertIsNone(bs.grant("g", 500, "grant:b1:x"))   # 同 token 重放
        self.assertEqual(self.model["bal"]["g"], 500)

    def test_distinct_tokens_accumulate(self):
        bs.grant("g", 500, "grant:b1:x")
        self.assertEqual(bs.grant("g", 300, "grant:b1:y"), 800)
        self.assertEqual(self.model["bal"]["g"], 800)

    def test_credit_limit_follows_grant(self):
        bs.grant("g", 500, "grant:b1:x")
        self.assertEqual(self.model["limit"]["g"], 500)       # limit 抬到发放后余额

    def test_set_credit_limit_can_be_disabled(self):
        bs.grant("g", 500, "grant:b1:x", set_credit_limit=False)
        self.assertNotIn("g", self.model["limit"])

    def test_grant_records_kind_and_balance_after(self):
        bs.grant("g", 700, "grant:b2:z", note="活动", actor="admin")
        row = self.model["ledger"][-1]
        self.assertEqual(row["kind"], bs.KIND_GRANT)
        self.assertEqual(row["balance_after"], 700)

    def test_rejects_nonpositive(self):
        with self.assertRaises(ValueError):
            bs.grant("g", 0, "grant:b1:x")


# ── 2. blueprint: /admin/tags + /admin/grant-by-tag ──────────────
_USERS = {"alice": {"username": "alice", "role": "user"},
          "admin": {"username": "admin", "role": "admin"}}
_PERMS = {"user": set(), "admin": {"billing.account"}, "super": {"*"}}

_GROUPS = {
    "p1": {"name": "p1", "tag": "活动X"},
    "p2": {"name": "p2", "tag": "活动X"},          # billable=0 → 跳过
    "p3": {"name": "p3", "tag": "活动X", "internal": True},   # 内部 → 跳过
    "p4": {"name": "p4", "tag": "其他"},
    "p5": {"name": "p5"},                          # 无 tag
}
_ACCOUNTS = [
    {"group_name": "p1", "balance_cents": 0, "billable": 1, "status": "active"},
    {"group_name": "p2", "balance_cents": 0, "billable": 0, "status": "active"},
]


def _grant_token(batch, group):
    return f"grant:{batch}:{hashlib.sha1(group.encode()).hexdigest()[:12]}"[:64]


class GrantByTagApi(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)

        users = MagicMock()
        users.get_user.side_effect = lambda name: _USERS.get(name)
        users.verify_token.return_value = None
        users.has_perm.side_effect = (lambda user, perm:
                                      perm in _PERMS.get((user or {}).get("role", "guest"), set()))
        sys.modules["users"] = users

        groups = MagicMock()
        groups.load_state.return_value = {"groups": _GROUPS}
        sys.modules["groups"] = groups

        bs_mock = MagicMock()
        bs_mock.list_accounts.return_value = _ACCOUNTS
        bs_mock.grant.return_value = 1000
        sys.modules["billing_store"] = bs_mock
        self.bs = bs_mock
        sys.modules["wallet"] = MagicMock()
        sys.modules["audit"] = MagicMock()

        api_pkg = types.ModuleType("api")
        api_pkg.__path__ = [str(ROOT / "api")]
        sys.modules["api"] = api_pkg
        for name, rel in (("api._auth", "api/_auth.py"), ("api.billing", "api/billing.py")):
            spec = importlib.util.spec_from_file_location(name, ROOT / rel)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            if name == "api.billing":
                self.billing = mod

        from flask import Flask
        app = Flask(__name__)
        app.secret_key = "test"
        app.register_blueprint(self.billing.billing_bp)
        self.client = app.test_client()

    def _login(self, who):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = who

    def _grant_args(self):
        return [c.args for c in self.bs.grant.call_args_list]

    # ── auth ─────────────────────────────────────────────────────
    def test_requires_billing_account(self):
        self._login("alice")
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 100})
        self.assertEqual(r.status_code, 403)
        self.bs.grant.assert_not_called()

    def test_anonymous_401(self):
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 100})
        self.assertEqual(r.status_code, 401)

    # ── validation ───────────────────────────────────────────────
    def test_missing_tag_400(self):
        self._login("admin")
        r = self.client.post("/api/billing/admin/grant-by-tag", json={"amount_cents": 100})
        self.assertEqual(r.status_code, 400)

    def test_nonpositive_amount_400(self):
        self._login("admin")
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 0})
        self.assertEqual(r.status_code, 400)
        self.bs.grant.assert_not_called()

    # ── selection ────────────────────────────────────────────────
    def test_only_matching_billable_noninternal(self):
        self._login("admin")
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 100})
        self.assertEqual(r.status_code, 200)
        granted = [g["group"] for g in r.get_json()["granted"]]
        self.assertEqual(granted, ["p1"])
        self.assertEqual([a[0] for a in self._grant_args()], ["p1"])
        skipped = {s["group"]: s["reason"] for s in r.get_json()["skipped"]}
        self.assertIn("p2", skipped)   # 已关闭计费
        self.assertIn("p3", skipped)   # 内部组

    def test_per_group_token_and_batch(self):
        self._login("admin")
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 100, "batch": "act1"})
        args = self._grant_args()
        self.assertEqual(args[0][2], _grant_token("act1", "p1"))
        self.assertEqual(r.get_json()["batch"], "act1")

    def test_replayed_batch_reports_reused(self):
        self._login("admin")
        self.bs.grant.return_value = None           # 模拟 token 已用过
        r = self.client.post("/api/billing/admin/grant-by-tag",
                             json={"tag": "活动X", "amount_cents": 100, "batch": "act1"})
        self.assertTrue(r.get_json()["granted"][0]["reused"])

    def test_auto_batch_tokens_are_unique_per_group(self):
        self._login("admin")
        # 让 p2 也可计费 → 两个组命中同一 tag
        self.bs.list_accounts.return_value = [
            {"group_name": "p1", "billable": 1}, {"group_name": "p2", "billable": 1}]
        self.client.post("/api/billing/admin/grant-by-tag",
                         json={"tag": "活动X", "amount_cents": 100})
        tokens = [a[2] for a in self._grant_args()]
        self.assertEqual(len(tokens), 2)
        self.assertEqual(len(set(tokens)), 2)       # 每组一个独立 token

    # ── /admin/tags preview ──────────────────────────────────────
    def test_tags_preview(self):
        self._login("admin")
        r = self.client.get("/api/billing/admin/tags")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        by_tag = {t["tag"]: t for t in body["tags"]}
        self.assertEqual(by_tag["活动X"]["count"], 3)
        self.assertEqual(by_tag["活动X"]["groups"], ["p1", "p2", "p3"])
        self.assertEqual(by_tag["活动X"]["internal"], 1)
        self.assertEqual(body["untagged"], 1)       # p5 无 tag
        self.assertEqual(body["count"], 2)          # 活动X / 其他

    def test_tags_requires_admin(self):
        self._login("alice")
        self.assertEqual(self.client.get("/api/billing/admin/tags").status_code, 403)


if __name__ == "__main__":
    unittest.main()
