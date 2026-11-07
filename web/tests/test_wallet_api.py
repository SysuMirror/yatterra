"""Wallet/allocation API surface (api/billing.py): auth + pod membership gates.

Loads the blueprint standalone with ``users`` / ``groups`` / ``wallet`` /
``billing_store`` stubbed — no DB, no app.py.  Verifies the two-layer rules:

- anyone can read **their own** wallet (``GET /wallet`` — no path param, no IDOR);
- allocation requires membership of the target pod, or an admin;
- reclaim (``/deallocate``) is admin-only;
- a non-positive amount / insufficient funds are rejected, not applied.
"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_USERS = {
    "alice": {"username": "alice", "role": "user"},
    "bob": {"username": "bob", "role": "user"},
    "admin": {"username": "admin", "role": "admin"},
}
# role → granted perms (mirrors users.ROLE_PERMS for the billing scopes)
_PERMS = {
    "user": {"billing.pay", "billing.allocate"},
    "admin": {"billing.pay", "billing.allocate", "billing.account", "billing.price"},
    "super": {"*"},
}
# pod membership: pod → {username: role}
_PODS = {"pod1": {"alice": "owner"}, "pod2": {"bob": "member"}}
_GROUPS = {"pod1": {"name": "pod1", "owners": ["alice"], "members": []},
           "pod2": {"name": "pod2", "owners": ["bob"], "members": []}}


def _stub_users():
    u = MagicMock()
    u.get_user.side_effect = lambda name: _USERS.get(name)
    u.verify_token.return_value = None
    u.has_perm.side_effect = (lambda user, perm:
                              perm in _PERMS.get((user or {}).get("role", "guest"), set()))
    u.pod_role.side_effect = lambda user, pod: (
        _PODS.get((pod or {}).get("name") if isinstance(pod, dict) else pod, {})
        .get((user or {}).get("username")))
    return u


class WalletApi(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)

        sys.modules["users"] = _stub_users()

        groups = MagicMock()
        groups.load_state.return_value = {"groups": _GROUPS}
        groups.internal_groups.return_value = set()
        sys.modules["groups"] = groups
        self.groups = groups

        wallet = MagicMock()
        wallet.get_account.return_value = {"username": "alice", "balance_cents": 10000,
                                           "credit_limit_cents": 0, "status": "active",
                                           "warn_ratio": 0.2}
        wallet.balance_ratio.return_value = None
        wallet.ledger.return_value = []
        wallet.is_frozen.return_value = False
        wallet.transfer_to_pod.return_value = 5000
        wallet.transfer_from_pod.return_value = 7000
        wallet.list_accounts.return_value = []
        sys.modules["wallet"] = wallet
        self.wallet = wallet

        bs = MagicMock()
        bs.get_account.side_effect = lambda name: {"group_name": name, "balance_cents": 0,
                                                   "status": "active", "billable": 1}
        sys.modules["billing_store"] = bs

        # a fake `api` package so `from api._auth import require_auth` does not run
        # the real api/__init__.py (which pulls in k8s/minio/... )
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

    # ── GET /wallet ──────────────────────────────────────────────
    def test_wallet_anonymous_401(self):
        self.assertEqual(self.client.get("/api/billing/wallet").status_code, 401)

    def test_wallet_returns_caller_own(self):
        self._login("alice")
        r = self.client.get("/api/billing/wallet")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["username"], "alice")
        self.assertEqual([p["name"] for p in body["pods"]], ["pod1"])

    # ── POST /allocate ───────────────────────────────────────────
    def test_allocate_owner_ok(self):
        self._login("alice")
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod1", "amount_cents": 5000})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])
        args = self.wallet.transfer_to_pod.call_args
        self.assertEqual(args.args[:3], ("pod1", "alice", 5000))

    def test_allocate_nonmember_403(self):
        self._login("alice")  # alice is not in pod2
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod2", "amount_cents": 5000})
        self.assertEqual(r.status_code, 403)
        self.wallet.transfer_to_pod.assert_not_called()

    def test_allocate_unknown_pod_404(self):
        self._login("alice")
        r = self.client.post("/api/billing/allocate",
                             json={"group": "nope", "amount_cents": 5000})
        self.assertEqual(r.status_code, 404)

    def test_allocate_nonpositive_400(self):
        self._login("alice")
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod1", "amount_cents": 0})
        self.assertEqual(r.status_code, 400)

    def test_allocate_insufficient_400(self):
        self._login("alice")
        self.wallet.transfer_to_pod.side_effect = ValueError("钱包余额不足")
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod1", "amount_cents": 999999})
        self.assertEqual(r.status_code, 400)

    def test_allocate_frozen_wallet_403(self):
        self._login("alice")
        self.wallet.is_frozen.return_value = True
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod1", "amount_cents": 100})
        self.assertEqual(r.status_code, 403)

    def test_internal_pod_hidden_and_rejected(self):
        """内部组免计费 → 不列在可分配 Pod 里，直接分配也被拒（钱进去就扣不到）。"""
        self.groups.internal_groups.return_value = {"pod1"}
        self.groups.load_state.return_value = {
            "groups": {k: dict(v, internal=(k == "pod1")) for k, v in _GROUPS.items()}}
        self._login("alice")
        body = self.client.get("/api/billing/wallet").get_json()
        self.assertEqual(body["pods"], [])
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod1", "amount_cents": 1000})
        self.assertEqual(r.status_code, 400)
        self.wallet.transfer_to_pod.assert_not_called()

    def test_admin_can_allocate_any_pod(self):
        self._login("admin")
        r = self.client.post("/api/billing/allocate",
                             json={"group": "pod2", "amount_cents": 100})
        self.assertEqual(r.status_code, 200)

    # ── POST /deallocate (admin only) ────────────────────────────
    def test_deallocate_user_403(self):
        self._login("alice")
        r = self.client.post("/api/billing/deallocate",
                             json={"username": "alice", "group": "pod1", "amount_cents": 100})
        self.assertEqual(r.status_code, 403)
        self.wallet.transfer_from_pod.assert_not_called()

    def test_deallocate_admin_ok(self):
        self._login("admin")
        r = self.client.post("/api/billing/deallocate",
                             json={"username": "alice", "group": "pod1", "amount_cents": 100})
        self.assertEqual(r.status_code, 200)
        self.wallet.transfer_from_pod.assert_called_once()


if __name__ == "__main__":
    unittest.main()
