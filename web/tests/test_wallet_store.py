"""wallet: the per-user wallet layer and the wallet↔pod transfer primitive.

No MySQL here — a fake cursor emulates just the SQL the wallet money paths issue
(``INSERT IGNORE`` rowcount, ``UPDATE ... balance ± ?``), so the invariants can be
asserted in isolation:

- an allocation moves money from the wallet to the pod, or neither side (atomic);
- a replayed ``transfer_token`` transfers nothing (the retried-request case);
- insufficient funds raises *and* rolls both sides back;
- a reclaim is capped at the pod's current balance (a pod can never go negative);
- a replayed top-up ``out_trade_no`` credits once;
- the cached balance always equals the sum of the ledger.
"""
import copy
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing_store as bs
import wallet


class _FakeCursor:
    """Minimal SQL emulator for the wallet + billing money statements."""

    def __init__(self, model):
        self.m = model
        self.rowcount = 0
        self._one = None
        self._all = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    # -- helpers ----------------------------------------------------
    def _insert_wallet(self, args):
        # credit_topup: (username, kind, cents, out_trade_no, note, actor)
        # transfer:     (username, kind, -cents, group_name, token, note, actor)
        if len(args) == 6:
            user, kind, amount, otn, note, actor = args
            group, token = None, None
            if otn is not None and otn in self.m["wotn"]:
                self.rowcount = 0
                return
            if otn is not None:
                self.m["wotn"].add(otn)
        else:
            user, kind, amount, group, token, note, actor = args
            otn = None
            if token is not None and token in self.m["wtoken"]:
                self.rowcount = 0
                return
            if token is not None:
                self.m["wtoken"].add(token)
        self.m["id"] += 1
        self.m["wledger"].append({"id": self.m["id"], "username": user, "kind": kind,
                                  "amount_cents": amount, "group_name": group,
                                  "transfer_token": token, "out_trade_no": otn,
                                  "balance_after": None})
        self.rowcount = 1

    def execute(self, sql, args=()):
        s = " ".join(sql.split())
        self.rowcount = 0
        self._one = None
        self._all = []
        if s.startswith("INSERT IGNORE INTO wallet_ledger"):
            self._insert_wallet(args)
        elif s.startswith("INSERT INTO wallet_ledger"):
            user, kind, amount = args[0], args[1], args[2]
            note, actor = args[-2], args[-1]
            self.m["id"] += 1
            self.m["wledger"].append({"id": self.m["id"], "username": user, "kind": kind,
                                      "amount_cents": amount, "group_name": None,
                                      "transfer_token": None, "out_trade_no": None,
                                      "balance_after": None})
            self.rowcount = 1
        elif s.startswith("INSERT IGNORE INTO billing_ledger"):
            group, kind, amount, token, note, actor = args
            if token is not None and token in self.m["btoken"]:
                self.rowcount = 0
                return
            if token is not None:
                self.m["btoken"].add(token)
            self.m["id"] += 1
            self.m["bledger"].append({"id": self.m["id"], "group_name": group, "kind": kind,
                                      "amount_cents": amount, "transfer_token": token,
                                      "balance_after": None})
            self.rowcount = 1
        elif s.startswith("INSERT IGNORE INTO wallet_accounts"):
            (user, limit) = args
            self.m["bal"].setdefault(user, 0)
            self.rowcount = 1
        elif "UPDATE wallet_accounts SET balance_cents = balance_cents + %s" in s:
            delta, user = args
            self.m["bal"][user] = self.m["bal"].get(user, 0) + delta
            self.rowcount = 1
        elif s.startswith("UPDATE wallet_accounts SET balance_cents=%s"):
            total, user = args
            self.m["bal"][user] = total
            self.rowcount = 1
        elif "UPDATE billing_accounts SET balance_cents = balance_cents + %s" in s:
            delta, group = args
            self.m["pbal"][group] = self.m["pbal"].get(group, 0) + delta
            self.rowcount = 1
        elif s.startswith("UPDATE wallet_ledger SET balance_after=") and "out_trade_no=" in s:
            bal, otn = args
            for row in reversed(self.m["wledger"]):
                if row["out_trade_no"] == otn:
                    row["balance_after"] = bal
                    break
            self.rowcount = 1
        elif s.startswith("UPDATE wallet_ledger SET balance_after=") and "id=LAST_INSERT_ID()" in s:
            (bal,) = args
            self.m["wledger"][-1]["balance_after"] = bal
            self.rowcount = 1
        elif s.startswith("UPDATE wallet_ledger SET balance_after=") and "transfer_token=" in s:
            bal, token = args
            for row in reversed(self.m["wledger"]):
                if row["transfer_token"] == token:
                    row["balance_after"] = bal
                    break
            self.rowcount = 1
        elif s.startswith("UPDATE billing_ledger SET balance_after=") and "transfer_token=" in s:
            bal, token = args
            for row in reversed(self.m["bledger"]):
                if row["transfer_token"] == token:
                    row["balance_after"] = bal
                    break
            self.rowcount = 1
        elif s.startswith("SELECT balance_cents FROM wallet_accounts"):
            (user,) = args
            self._one = {"balance_cents": self.m["bal"].get(user, 0)}
        elif s.startswith("SELECT balance_cents FROM billing_accounts"):
            group = args[0]
            self._one = {"balance_cents": self.m["pbal"].get(group, 0)}
        elif s.startswith("SELECT COALESCE(SUM(amount_cents),0) AS s FROM wallet_ledger"):
            (user,) = args
            self._one = {"s": sum(r["amount_cents"] for r in self.m["wledger"]
                                  if r["username"] == user)}
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


# the model keys a transfer touches — snapshotted for rollback emulation
_SNAP = ("wledger", "bledger", "bal", "pbal", "wotn", "wtoken", "btoken", "id")


class Transfers(unittest.TestCase):
    def setUp(self):
        self.model = {"wledger": [], "bledger": [], "bal": {}, "pbal": {},
                      "wotn": set(), "wtoken": set(), "btoken": set(), "id": 0}
        self.conn = _FakeConn(self.model)

        @contextmanager
        def fake_tx():
            snap = {k: copy.deepcopy(self.model[k]) for k in _SNAP}
            try:
                yield self.conn
            except Exception:
                for k, v in snap.items():
                    self.model[k] = v
                raise

        patches = [
            mock.patch.object(wallet, "ensure_schema", lambda: None),
            mock.patch.object(wallet, "ensure_account", lambda u, **k: {"username": u}),
            mock.patch.object(bs, "ensure_schema", lambda: None),
            mock.patch.object(bs, "ensure_account", lambda g, **k: {"group_name": g}),
            mock.patch.object(bs, "tx", fake_tx),
            mock.patch.object(wallet.users, "_conn", lambda: self.conn),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    # ── top-up ───────────────────────────────────────────────────
    def test_topup_credits_once(self):
        self.assertEqual(wallet.credit_topup("alice", 10000, "OTN-1"), 10000)
        self.assertIsNone(wallet.credit_topup("alice", 10000, "OTN-1"))  # replay
        self.assertEqual(self.model["bal"]["alice"], 10000)

    def test_topup_rejects_nonpositive(self):
        with self.assertRaises(ValueError):
            wallet.credit_topup("alice", 0, "OTN-0")

    # ── allocate (wallet → pod) ──────────────────────────────────
    def test_transfer_moves_both_sides(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        bal = wallet.transfer_to_pod("pod", "alice", 3000, token="T1")
        self.assertEqual(bal, 7000)
        self.assertEqual(self.model["bal"]["alice"], 7000)
        self.assertEqual(self.model["pbal"]["pod"], 3000)
        kinds = sorted(r["kind"] for r in self.model["wledger"])
        self.assertEqual(kinds, ["allocate", "topup"])
        self.assertEqual([r["kind"] for r in self.model["bledger"]], ["allocation"])
        # balance_after backfilled on both sides
        self.assertEqual(self.model["wledger"][-1]["balance_after"], 7000)
        self.assertEqual(self.model["bledger"][-1]["balance_after"], 3000)

    def test_transfer_replay_is_noop(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        wallet.transfer_to_pod("pod", "alice", 3000, token="T1")
        self.assertIsNone(wallet.transfer_to_pod("pod", "alice", 3000, token="T1"))
        self.assertEqual(self.model["bal"]["alice"], 7000)
        self.assertEqual(self.model["pbal"]["pod"], 3000)

    def test_transfer_insufficient_rolls_back(self):
        wallet.credit_topup("alice", 1000, "OTN-1")
        with self.assertRaises(ValueError):
            wallet.transfer_to_pod("pod", "alice", 5000, token="T1")
        self.assertEqual(self.model["bal"]["alice"], 1000)   # wallet untouched
        self.assertEqual(self.model["pbal"].get("pod", 0), 0)  # pod untouched
        self.assertEqual(len(self.model["wledger"]), 1)      # only the top-up row

    def test_transfer_rejects_nonpositive(self):
        wallet.credit_topup("alice", 1000, "OTN-1")
        with self.assertRaises(ValueError):
            wallet.transfer_to_pod("pod", "alice", 0, token="T1")

    # ── reclaim (pod → wallet) ───────────────────────────────────
    def test_reclaim_mirror(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        wallet.transfer_to_pod("pod", "alice", 3000, token="T1")
        bal = wallet.transfer_from_pod("pod", "alice", 2000, token="T2")
        self.assertEqual(bal, 9000)
        self.assertEqual(self.model["bal"]["alice"], 9000)
        self.assertEqual(self.model["pbal"]["pod"], 1000)

    def test_reclaim_capped_at_pod_balance(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        wallet.transfer_to_pod("pod", "alice", 3000, token="T1")
        bal = wallet.transfer_from_pod("pod", "alice", 5000, token="T2")  # ask 5000
        self.assertEqual(bal, 10000)                       # only 3000 came back
        self.assertEqual(self.model["pbal"]["pod"], 0)
        back = [r for r in self.model["wledger"] if r["kind"] == "deallocate"][0]
        self.assertEqual(back["amount_cents"], 3000)

    def test_reclaim_empty_pod_raises(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        with self.assertRaises(ValueError):
            wallet.transfer_from_pod("pod", "alice", 1000, token="T2")

    def test_reclaim_replay_is_noop(self):
        wallet.credit_topup("alice", 10000, "OTN-1")
        wallet.transfer_to_pod("pod", "alice", 3000, token="T1")
        wallet.transfer_from_pod("pod", "alice", 1000, token="T2")
        self.assertIsNone(wallet.transfer_from_pod("pod", "alice", 1000, token="T2"))
        self.assertEqual(self.model["bal"]["alice"], 8000)

    # ── ledger/recompute ─────────────────────────────────────────
    def test_recompute_matches_cache(self):
        wallet.credit_topup("alice", 5000, "OTN-1")
        wallet.transfer_to_pod("pod", "alice", 1500, token="T1")
        wallet.transfer_from_pod("pod", "alice", 500, token="T2")
        self.assertEqual(wallet.recompute_balance("alice"), self.model["bal"]["alice"])


if __name__ == "__main__":
    unittest.main()
