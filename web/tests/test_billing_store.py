"""billing_store: idempotent top-up / charge and the balance arithmetic.

No MySQL here — a fake cursor emulates just the bits of SQL the money paths
issue (``INSERT IGNORE`` rowcount, ``UPDATE balance = balance ± ?``), so the
invariants can be asserted in isolation:

- a replayed ``out_trade_no`` credits nothing (the payment-callback replay case);
- a replayed ``(group, period, resource)`` charges nothing (the settle-restart
  case);
- the cached balance always equals the sum of the ledger.
"""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing_store as bs


class _FakeCursor:
    """Minimal SQL emulator for the billing money statements."""

    def __init__(self, model):
        self.m = model
        self.rowcount = 0
        self._one = None
        self._all = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, args=()):
        s = " ".join(sql.split())
        self.rowcount = 0
        self._one = None
        self._all = []
        if s.startswith("INSERT IGNORE INTO billing_ledger"):
            group, kind, amount, otn, note, actor = args
            if otn is not None and otn in self.m["otn"]:
                self.rowcount = 0
                return
            if otn is not None:
                self.m["otn"].add(otn)
            self.m["id"] += 1
            self.m["ledger"].append({"id": self.m["id"], "group_name": group, "kind": kind,
                                     "amount_cents": amount, "out_trade_no": otn,
                                     "balance_after": None})
            self.rowcount = 1
        elif s.startswith("INSERT INTO billing_ledger"):
            group, kind, amount = args[0], args[1], args[2]
            note, actor = args[-2], args[-1]
            self.m["id"] += 1
            self.m["ledger"].append({"id": self.m["id"], "group_name": group, "kind": kind,
                                     "amount_cents": amount, "out_trade_no": None,
                                     "balance_after": None})
            self.rowcount = 1
        elif s.startswith("INSERT IGNORE INTO billing_charges"):
            group, ps, pe, key, cents = args
            pk = (group, ps, pe, key)
            if pk in self.m["charges"]:
                self.rowcount = 0
                return
            self.m["charges"][pk] = cents
            self.rowcount = 1
        elif "UPDATE billing_accounts SET balance_cents = balance_cents + %s" in s:
            delta, group = args
            self.m["bal"][group] = self.m["bal"].get(group, 0) + delta
            self.rowcount = 1
        elif s.startswith("UPDATE billing_accounts SET balance_cents=%s"):
            total, group = args
            self.m["bal"][group] = total
            self.rowcount = 1
        elif s.startswith("UPDATE billing_ledger SET balance_after=") and "WHERE id=LAST_INSERT_ID()" in s:
            (bal,) = args
            self.m["ledger"][-1]["balance_after"] = bal
            self.rowcount = 1
        elif s.startswith("UPDATE billing_ledger SET balance_after=") and "out_trade_no=" in s:
            bal, otn = args
            for row in reversed(self.m["ledger"]):
                if row["out_trade_no"] == otn:
                    row["balance_after"] = bal
                    break
            self.rowcount = 1
        elif s.startswith("SELECT balance_cents FROM billing_accounts"):
            (group,) = args
            self._one = {"balance_cents": self.m["bal"].get(group, 0)}
        elif s.startswith("SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_ledger"):
            (group,) = args
            self._one = {"s": sum(r["amount_cents"] for r in self.m["ledger"]
                                  if r["group_name"] == group)}
        else:  # pragma: no cover - surfaces stray SQL in tests
            raise AssertionError(f"unexpected SQL: {s}")

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._all


class _FakeConn:
    def __init__(self, model):
        self.m = model

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _FakeCursor(self.m)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class Money(unittest.TestCase):
    def setUp(self):
        self.model = {"ledger": [], "charges": {}, "bal": {}, "otn": set(), "id": 0}
        self.conn = _FakeConn(self.model)

        @contextmanager
        def fake_tx():
            yield self.conn

        patches = [
            mock.patch.object(bs, "ensure_schema", lambda: None),
            mock.patch.object(bs, "ensure_account", lambda g, **k: {"group_name": g}),
            mock.patch.object(bs, "tx", fake_tx),
            mock.patch.object(bs.users, "_conn", lambda: self.conn),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_topup_credits_once(self):
        self.assertEqual(bs.credit_topup("g", 10000, "OTN-1"), 10000)
        self.assertIsNone(bs.credit_topup("g", 10000, "OTN-1"))  # replay
        self.assertEqual(self.model["bal"]["g"], 10000)

    def test_charge_is_idempotent_per_period(self):
        rows = [{"resource_key": "cpu_core_hour", "units": 10, "unit_price_cents": 1, "cost_cents": 10}]
        self.assertEqual(bs.charge_period("g", 100, 200, rows), 10)
        self.assertEqual(bs.charge_period("g", 100, 200, rows), 0)   # replay
        self.assertEqual(bs.charge_period("g", 200, 300, rows), 10)  # next period
        self.assertEqual(self.model["bal"]["g"], -20)

    def test_zero_cost_rows_are_not_recorded(self):
        rows = [{"resource_key": "mem_gib_hour", "units": 5, "unit_price_cents": 0, "cost_cents": 0}]
        self.assertEqual(bs.charge_period("g", 1, 2, rows), 0)
        self.assertEqual(self.model["charges"], {})

    def test_balance_matches_ledger_sum(self):
        bs.credit_topup("g", 5000, "OTN-2")
        rows = [{"resource_key": "cpu_core_hour", "units": 3, "unit_price_cents": 100, "cost_cents": 300}]
        bs.charge_period("g", 1, 2, rows)
        self.assertEqual(bs.recompute_balance("g"), self.model["bal"]["g"])

    def test_adjustment_can_be_negative(self):
        bs.adjust("g", -250, note="refund")
        self.assertEqual(self.model["bal"]["g"], -250)

    def test_topup_rejects_nonpositive(self):
        with self.assertRaises(ValueError):
            bs.credit_topup("g", 0, "OTN-0")


if __name__ == "__main__":
    unittest.main()
