"""pay.settle_paid: a paid top-up credits the **wallet** (new) or a group (legacy).

``settle_paid`` is the money-in path for the payment callback.  After the wallet
model it must route by ``credit_target``:

- ``wallet`` (default for new orders)  → ``wallet.credit_topup(username, ...)``;
- ``group``  (legacy orders)           → ``billing_store.credit_topup(group, ...)``,
  with a fallback to group routing when ``credit_target`` is absent but a
  ``group_name`` is present.

The credit is idempotent (the ledger's ``UNIQUE(out_trade_no)`` makes a replay a
no-op returning ``None``), and the order is only marked paid afterwards.
"""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pay as pay_mod
import billing_store as bs
import wallet


class _StubConn:
    committed = True

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return self

    def execute(self, *a, **k):
        return 1

    def fetchone(self):
        return None

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class _StubUsers:
    def _conn(self):
        return _StubConn()


class SettleRouting(unittest.TestCase):
    def setUp(self):
        self.wallet_calls = []
        self.group_calls = []

        def w_topup(username, amount, otn, note="", actor=""):
            self.wallet_calls.append((username, amount, otn))
            return amount if len(self.wallet_calls) == 1 else None  # 2nd = replay

        def g_topup(group, amount, otn, note="", actor=""):
            self.group_calls.append((group, amount, otn))
            return amount

        self._patches = [
            mock.patch.object(wallet, "credit_topup", w_topup),
            mock.patch.object(bs, "credit_topup", g_topup),
            mock.patch.object(pay_mod, "_users", lambda: _StubUsers()),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def _order(self, **over):
        o = {
            "out_trade_no": "OTN-1", "credit_cents": 5000, "subject": "¥50",
            "item_key": "cny50", "group_name": "", "username": "alice",
            "status": "pending", "credit_target": "wallet",
        }
        o.update(over)
        return o

    def test_wallet_target_credits_wallet(self):
        with mock.patch.object(pay_mod, "get_order", lambda no: self._order()):
            credited = pay_mod.settle_paid("OTN-1", "tx1", {"source": "test"})
        self.assertEqual(credited, 5000)
        self.assertEqual(self.wallet_calls, [("alice", 5000, "OTN-1")])
        self.assertEqual(self.group_calls, [])

    def test_group_target_credits_group(self):
        order = self._order(group_name="g1", username=None, credit_target="group")
        with mock.patch.object(pay_mod, "get_order", lambda no: order):
            credited = pay_mod.settle_paid("OTN-1", "tx1", {"source": "test"})
        self.assertEqual(credited, 5000)
        self.assertEqual(self.group_calls, [("g1", 5000, "OTN-1")])
        self.assertEqual(self.wallet_calls, [])

    def test_legacy_group_order_without_flag_routes_to_group(self):
        order = self._order(group_name="g1", username=None)
        order.pop("credit_target")
        with mock.patch.object(pay_mod, "get_order", lambda no: order):
            credited = pay_mod.settle_paid("OTN-1", "tx1", {"source": "test"})
        self.assertEqual(credited, 5000)
        self.assertEqual(self.group_calls, [("g1", 5000, "OTN-1")])

    def test_replayed_wallet_callback_credits_once(self):
        with mock.patch.object(pay_mod, "get_order", lambda no: self._order()):
            first = pay_mod.settle_paid("OTN-1", "tx1", {"source": "test"})
            second = pay_mod.settle_paid("OTN-1", "tx1", {"source": "test"})
        self.assertEqual(first, 5000)
        self.assertEqual(second, 0)                 # nothing new credited
        self.assertEqual(len(self.wallet_calls), 2)  # but the dedupe layer was asked

    def test_unknown_order_credits_nothing(self):
        with mock.patch.object(pay_mod, "get_order", lambda no: None):
            self.assertEqual(pay_mod.settle_paid("NOPE"), 0)
        self.assertEqual(self.wallet_calls, [])
        self.assertEqual(self.group_calls, [])


if __name__ == "__main__":
    unittest.main()
