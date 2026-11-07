#!/usr/bin/env python3
"""Per-user wallet layer + the wallet↔pod allocation transfer primitive.

Two-layer money model
---------------------

* **wallet_accounts / wallet_ledger** (this module) — the *person's* prepaid
  balance.  Top-ups from the payment gateway land here; an *allocation*
  transfers money out to a pod.
* **billing_accounts / billing_ledger** (``billing_store``) — the *pod's* own
  quota.  The hourly settlement daemon drains it, so each pod is charged
  independently of every other pod and of its owner's wallet.

An allocation is a single transaction that debits the wallet and credits the
pod, or does neither.  Exactly-once is by ``transfer_token``: the same token is
a UNIQUE key on both ledgers, so a retried request is absorbed by
``INSERT IGNORE`` and the second call is a clean no-op.

Money is **integer cents**; ``wallet_ledger`` is append-only and authoritative
and the cached ``balance_cents`` is a recomputable projection of it, exactly as
in ``billing_store``.  Transactions share ``billing_store.tx()`` so a transfer
commits both sides atomically (see ``transfer_to_pod``).
"""
import threading
from importlib import import_module

import billing_store
import users

_INIT_LOCK = threading.Lock()
_INITED = False

STATUS_ACTIVE = "active"
STATUS_SUSPENDED = "suspended"
STATUS_CLOSED = "closed"
STATUSES = (STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_CLOSED)

KIND_TOPUP = "topup"
KIND_ALLOCATE = "allocate"        # wallet side of wallet→pod
KIND_DEALLOCATE = "deallocate"    # wallet side of pod→wallet
KIND_ADJUSTMENT = "adjustment"
KIND_REFUND = "refund"

# pod (billing_ledger) side kinds for the two transfer directions
POD_KIND_ALLOCATION = "allocation"
POD_KIND_DEALLOCATION = "deallocation"

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS wallet_accounts (
        username           VARCHAR(64)  PRIMARY KEY,
        balance_cents      BIGINT       NOT NULL DEFAULT 0,
        credit_limit_cents BIGINT       NOT NULL DEFAULT 0,
        status             VARCHAR(16)  NOT NULL DEFAULT 'active',
        warn_ratio         DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
        updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS wallet_ledger (
        id             BIGINT       AUTO_INCREMENT PRIMARY KEY,
        username       VARCHAR(64)  NOT NULL,
        kind           VARCHAR(16)  NOT NULL,
        amount_cents   BIGINT       NOT NULL,
        group_name     VARCHAR(64)  NULL,
        balance_after  BIGINT       NULL,
        out_trade_no   VARCHAR(64)  NULL,
        transfer_token VARCHAR(64)  NULL,
        note           VARCHAR(255) NOT NULL DEFAULT '',
        actor          VARCHAR(64)  NOT NULL DEFAULT '',
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_topup (out_trade_no),
        UNIQUE KEY uniq_transfer (transfer_token),
        INDEX idx_user_time (username, created_at),
        INDEX idx_kind_time (kind, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
)


def ensure_schema():
    """Create the wallet tables once.  Must NOT call back into billing_store
    (``billing_store.ensure_schema`` calls this one)."""
    global _INITED
    if _INITED:
        return
    users._ensure_init()
    with _INIT_LOCK:
        if _INITED:
            return
        with users._conn() as cn:
            with cn.cursor() as cur:
                for ddl in _DDL:
                    cur.execute(ddl)
        _INITED = True


def _rows(cur):
    return cur.fetchall() or []


# ── accounts ─────────────────────────────────────────────────────
def get_account(username):
    """Wallet row, or None if this user has never had one."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM wallet_accounts WHERE username=%s", (username,))
        return cur.fetchone()


def ensure_account(username, credit_limit_cents=0):
    """Create the wallet if absent; never clobbers an existing balance."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT IGNORE INTO wallet_accounts (username, credit_limit_cents)
               VALUES (%s, %s)""",
            (username, int(credit_limit_cents)),
        )
    return get_account(username)


def set_account(username, *, status=None, credit_limit_cents=None):
    """Admin override of wallet flags.  Returns the updated row."""
    ensure_schema()
    if status is not None and status not in STATUSES:
        raise ValueError(f"未知钱包状态: {status}")
    sets, args = [], []
    if status is not None:
        sets.append("status=%s"); args.append(status)
    if credit_limit_cents is not None:
        sets.append("credit_limit_cents=%s"); args.append(int(credit_limit_cents))
    if sets:
        args.append(username)
        with users._conn() as cn, cn.cursor() as cur:
            cur.execute(f"UPDATE wallet_accounts SET {', '.join(sets)} WHERE username=%s", args)
    return get_account(username)


def list_accounts():
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM wallet_accounts ORDER BY username")
        return _rows(cur)


def _apply_balance(cur, username, delta_cents):
    """Move the cached wallet balance by ``delta`` and return the new value."""
    cur.execute(
        "UPDATE wallet_accounts SET balance_cents = balance_cents + %s WHERE username=%s",
        (int(delta_cents), username),
    )
    cur.execute("SELECT balance_cents FROM wallet_accounts WHERE username=%s", (username,))
    row = cur.fetchone()
    return int(row["balance_cents"]) if row else None


# ── money movements ──────────────────────────────────────────────
def credit_topup(username, amount_cents, out_trade_no, note="", actor=""):
    """Credit a paid top-up to the wallet exactly once (keyed by out_trade_no).

    Returns the new balance, or ``None`` when the ``out_trade_no`` was already
    settled (a replayed gateway callback is a no-op, not an error).
    """
    ensure_schema()
    cents = int(amount_cents)
    if cents <= 0:
        raise ValueError("充值金额必须为正")
    ensure_account(username)
    with billing_store.tx() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT IGNORE INTO wallet_ledger
                   (username, kind, amount_cents, out_trade_no, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (username, KIND_TOPUP, cents, out_trade_no, note or "", actor or ""),
        )
        if cur.rowcount == 0:
            return None  # duplicate out_trade_no — already credited
        bal = _apply_balance(cur, username, cents)
        cur.execute("UPDATE wallet_ledger SET balance_after=%s WHERE out_trade_no=%s",
                    (bal, out_trade_no))
    return bal


def adjust(username, amount_cents, note="", actor=""):
    """Manual correction (signed cents).  Always applies."""
    ensure_schema()
    cents = int(amount_cents)
    ensure_account(username)
    with billing_store.tx() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT INTO wallet_ledger (username, kind, amount_cents, note, actor)
               VALUES (%s, %s, %s, %s, %s)""",
            (username, KIND_ADJUSTMENT, cents, note or "", actor or ""),
        )
        bal = _apply_balance(cur, username, cents)
        cur.execute("UPDATE wallet_ledger SET balance_after=%s WHERE id=LAST_INSERT_ID()",
                    (bal,))
    return bal


def transfer_to_pod(group_name, username, amount_cents, *, token, note="", actor=""):
    """Move ``cents`` from ``username``'s wallet into ``group_name``'s pod quota.

    Atomic and exactly-once: both ledger rows share ``token`` (UNIQUE), so a
    replay returns ``None``.  Insufficient funds raises (and rolls back — no
    side is touched).  Returns the new wallet balance on success.
    """
    ensure_schema()
    billing_store.ensure_account(group_name)
    ensure_account(username)
    cents = int(amount_cents)
    if cents <= 0:
        raise ValueError("分配金额必须为正")
    with billing_store.tx() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT IGNORE INTO wallet_ledger
                   (username, kind, amount_cents, group_name, transfer_token, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (username, KIND_ALLOCATE, -cents, group_name, token, note or "", actor or ""),
        )
        if cur.rowcount == 0:
            return None  # replayed token — already transferred
        wal = _apply_balance(cur, username, -cents)
        if wal is None or wal < 0:
            raise ValueError("钱包余额不足")
        cur.execute(
            """INSERT IGNORE INTO billing_ledger
                   (group_name, kind, amount_cents, transfer_token, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (group_name, POD_KIND_ALLOCATION, cents, token, note or "", actor or ""),
        )
        if cur.rowcount == 0:  # unreachable with a fresh token, but keep sane
            raise ValueError("转账令牌冲突")
        pod = billing_store._apply_balance(cur, group_name, cents)
        cur.execute("UPDATE billing_ledger SET balance_after=%s WHERE transfer_token=%s",
                    (pod, token))
        cur.execute("UPDATE wallet_ledger SET balance_after=%s WHERE transfer_token=%s",
                    (wal, token))
    return wal


def transfer_from_pod(group_name, username, amount_cents, *, token, note="", actor=""):
    """Move unused pod quota back into ``username``'s wallet (admin reclaim).

    Capped at the pod's current balance so a pod can never be driven negative.
    Atomic + exactly-once by ``token``.  Returns the new wallet balance.
    """
    ensure_schema()
    billing_store.ensure_account(group_name)
    ensure_account(username)
    cents = int(amount_cents)
    if cents <= 0:
        raise ValueError("收回金额必须为正")
    with billing_store.tx() as cn, cn.cursor() as cur:
        cur.execute("SELECT balance_cents FROM billing_accounts WHERE group_name=%s FOR UPDATE",
                    (group_name,))
        row = cur.fetchone()
        pod_bal = int((row or {}).get("balance_cents") or 0)
        cents = min(cents, max(pod_bal, 0))
        if cents <= 0:
            raise ValueError("该 Pod 没有可收回的额度")
        cur.execute(
            """INSERT IGNORE INTO wallet_ledger
                   (username, kind, amount_cents, group_name, transfer_token, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (username, KIND_DEALLOCATE, cents, group_name, token, note or "", actor or ""),
        )
        if cur.rowcount == 0:
            return None  # replayed token
        cur.execute(
            """INSERT IGNORE INTO billing_ledger
                   (group_name, kind, amount_cents, transfer_token, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (group_name, POD_KIND_DEALLOCATION, -cents, token, note or "", actor or ""),
        )
        if cur.rowcount == 0:
            raise ValueError("转账令牌冲突")
        pod = billing_store._apply_balance(cur, group_name, -cents)
        wal = _apply_balance(cur, username, cents)
        cur.execute("UPDATE billing_ledger SET balance_after=%s WHERE transfer_token=%s",
                    (pod, token))
        cur.execute("UPDATE wallet_ledger SET balance_after=%s WHERE transfer_token=%s",
                    (wal, token))
    return wal


def ledger(username, limit=100, offset=0):
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """SELECT id, kind, amount_cents, group_name, balance_after,
                      out_trade_no, transfer_token, note, actor, created_at
               FROM wallet_ledger WHERE username=%s
               ORDER BY id DESC LIMIT %s OFFSET %s""",
            (username, int(limit), int(offset)),
        )
        return _rows(cur)


def recompute_balance(username):
    """Re-derive the cached wallet balance from the ledger (repair / audit)."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(SUM(amount_cents),0) AS s FROM wallet_ledger WHERE username=%s",
            (username,),
        )
        total = int((cur.fetchone() or {}).get("s") or 0)
        cur.execute("UPDATE wallet_accounts SET balance_cents=%s WHERE username=%s",
                    (total, username))
    return total


# ── read helpers ─────────────────────────────────────────────────
def balance_ratio(account):
    """Fraction of the credit limit still available, or None if no limit."""
    if not account:
        return None
    limit = int(account.get("credit_limit_cents") or 0)
    if limit <= 0:
        return None
    return int(account.get("balance_cents") or 0) / limit


def is_frozen(username):
    """Admin freeze gate: True when the wallet is suspended/closed."""
    acct = get_account(username)
    return bool(acct) and acct.get("status") in (STATUS_SUSPENDED, STATUS_CLOSED)
