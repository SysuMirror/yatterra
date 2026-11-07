#!/usr/bin/env python3
"""Money layer: prices, accounts (balances), ledger, and idempotent charges.

Physical usage lives in the SQLite time-series store (``usage_store``); the
money it translates to lives here, in MySQL (the ``yatterra`` database managed
by ``users.py``).  MySQL is the right home for it because the guarantees the
money needs are relational ones:

- **idempotency by UNIQUE key** — a replayed tick, a retried HTTP callback, or
  the settlement daemon crashing mid-period must never double-charge.  Charges
  are keyed by ``(group, period_start, period_end, resource_key)`` and topups
  by ``out_trade_no``; both are absorbed by ``INSERT IGNORE``.
- **atomic balance arithmetic** — money moves as ``UPDATE ... SET balance =
  balance ± %s`` inside a transaction, never read-modify-write in Python.

Design notes
------------
* Money is **integer cents**; unit prices are ``DECIMAL(18,6)`` cents-per-unit
  so fractional rates (e.g. 0.35¢ per GiB·h) stay exact.
* ``billing_ledger`` is append-only and authoritative — the running balance is
  a cached projection of it, recomputable with ``recompute_balance``.
* Connections are short-lived and **not** taken from the web request pool: a
  money transaction must not sit inside a pooled autocommit connection that a
  neighbouring request might reuse mid-transaction.
"""
import threading
from contextlib import contextmanager
from importlib import import_module

import pymysql

users = import_module("users")

_INIT_LOCK = threading.Lock()
_INITED = False

STATUS_ACTIVE = "active"
STATUS_SUSPENDED = "suspended"
STATUS_CLOSED = "closed"
STATUSES = (STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_CLOSED)

KIND_CHARGE = "charge"
KIND_TOPUP = "topup"
KIND_ADJUSTMENT = "adjustment"
KIND_REFUND = "refund"

_DDL = (
    """
    CREATE TABLE IF NOT EXISTS billing_prices (
        resource_key     VARCHAR(48)   PRIMARY KEY,
        unit_price_cents DECIMAL(18,6) NOT NULL DEFAULT 0,
        currency         VARCHAR(8)    NOT NULL DEFAULT 'CNY',
        updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
        updated_by       VARCHAR(64)   NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS billing_accounts (
        group_name         VARCHAR(64)  PRIMARY KEY,
        balance_cents      BIGINT       NOT NULL DEFAULT 0,
        credit_limit_cents BIGINT       NOT NULL DEFAULT 0,
        status             VARCHAR(16)  NOT NULL DEFAULT 'active',
        billable           TINYINT      NOT NULL DEFAULT 1,
        warn_ratio         DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
        updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS billing_ledger (
        id               BIGINT       AUTO_INCREMENT PRIMARY KEY,
        group_name       VARCHAR(64)  NOT NULL,
        kind             VARCHAR(16)  NOT NULL,
        amount_cents     BIGINT       NOT NULL,
        resource_key     VARCHAR(48)  NULL,
        units            DECIMAL(18,6) NULL,
        unit_price_cents DECIMAL(18,6) NULL,
        balance_after    BIGINT       NULL,
        period_start     BIGINT       NULL,
        period_end       BIGINT       NULL,
        out_trade_no     VARCHAR(64)  NULL,
        transfer_token   VARCHAR(64)  NULL,
        note             VARCHAR(255) NOT NULL DEFAULT '',
        actor            VARCHAR(64)  NOT NULL DEFAULT '',
        created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_topup (out_trade_no),
        UNIQUE KEY uniq_transfer (transfer_token),
        INDEX idx_group_time (group_name, created_at),
        INDEX idx_kind_time (kind, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
    """
    CREATE TABLE IF NOT EXISTS billing_charges (
        group_name   VARCHAR(64)  NOT NULL,
        period_start BIGINT       NOT NULL,
        period_end   BIGINT       NOT NULL,
        resource_key VARCHAR(48)  NOT NULL,
        cost_cents   BIGINT       NOT NULL,
        created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_name, period_start, period_end, resource_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """,
)


def _column_exists(cur, table, column):
    cur.execute("SELECT COUNT(*) AS n FROM information_schema.columns "
                "WHERE table_schema=DATABASE() AND table_name=%s AND column_name=%s",
                (table, column))
    return bool((cur.fetchone() or {}).get("n"))


def _index_exists(cur, table, index):
    cur.execute("SELECT COUNT(*) AS n FROM information_schema.statistics "
                "WHERE table_schema=DATABASE() AND table_name=%s AND index_name=%s",
                (table, index))
    return bool((cur.fetchone() or {}).get("n"))


def _migrate(cur):
    """Guarded additive migrations (re-running ``ensure_schema`` is a no-op).

    ``billing_ledger.transfer_token`` + its unique key back the wallet↔pod
    transfer idempotency (see ``wallet.transfer_to_pod``).  Existing rows get a
    NULL token; MySQL unique keys allow many NULLs, so nothing is affected.
    """
    if not _column_exists(cur, "billing_ledger", "transfer_token"):
        cur.execute("ALTER TABLE billing_ledger ADD COLUMN transfer_token VARCHAR(64) NULL")
    if not _index_exists(cur, "billing_ledger", "uniq_transfer"):
        cur.execute("ALTER TABLE billing_ledger ADD UNIQUE KEY uniq_transfer (transfer_token)")


def ensure_schema():
    """Create the billing tables once (piggybacks on users.py's DB bootstrap)."""
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
                _migrate(cur)
        _INITED = True
    # The per-user wallet layer shares this bootstrap path; it must not call
    # back into ensure_schema (it owns only its own tables).
    import wallet  # noqa: E402  (local import avoids an import cycle)
    wallet.ensure_schema()


@contextmanager
def tx():
    """Short transactional connection (autocommit OFF), rolled back on error."""
    cfg = dict(users._db_config())
    cfg["autocommit"] = False
    cn = pymysql.connect(**cfg)
    try:
        yield cn
        cn.commit()
    except Exception:
        try:
            cn.rollback()
        except Exception:
            pass
        raise
    finally:
        cn.close()


def _rows(cur):
    return cur.fetchall() or []


# ── prices ───────────────────────────────────────────────────────
def get_prices():
    """{resource_key: float cents}.  Missing keys are simply absent."""
    ensure_schema()
    import billing_core
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT resource_key, unit_price_cents FROM billing_prices")
        stored = {r["resource_key"]: float(r["unit_price_cents"] or 0) for r in _rows(cur)}
    return {k: stored.get(k, 0.0) for k in billing_core.RESOURCE_KEYS}


def set_price(resource_key, unit_price_cents, actor=""):
    """Upsert one resource price (cents per unit).  Returns the new value."""
    ensure_schema()
    cents = max(0.0, float(unit_price_cents))
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT INTO billing_prices (resource_key, unit_price_cents, updated_by)
               VALUES (%s, %s, %s)
               ON DUPLICATE KEY UPDATE unit_price_cents=VALUES(unit_price_cents),
                                       updated_by=VALUES(updated_by)""",
            (resource_key, cents, actor or ""),
        )
    return cents


# ── accounts ─────────────────────────────────────────────────────
def get_account(group_name):
    """Account row, or None if the group has never been billed."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM billing_accounts WHERE group_name=%s", (group_name,))
        r = cur.fetchone()
    return r


def ensure_account(group_name, billable=1, credit_limit_cents=0):
    """Create the account if absent; never clobbers an existing balance."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT IGNORE INTO billing_accounts
                   (group_name, billable, credit_limit_cents)
               VALUES (%s, %s, %s)""",
            (group_name, 1 if billable else 0, int(credit_limit_cents)),
        )
    return get_account(group_name)


def set_account(group_name, *, status=None, billable=None, credit_limit_cents=None):
    """Admin override of account flags.  Returns the updated row."""
    ensure_schema()
    if status is not None and status not in STATUSES:
        raise ValueError(f"未知账户状态: {status}")
    sets, args = [], []
    if status is not None:
        sets.append("status=%s"); args.append(status)
    if billable is not None:
        sets.append("billable=%s"); args.append(1 if billable else 0)
    if credit_limit_cents is not None:
        sets.append("credit_limit_cents=%s"); args.append(int(credit_limit_cents))
    if sets:
        args.append(group_name)
        with users._conn() as cn, cn.cursor() as cur:
            cur.execute(f"UPDATE billing_accounts SET {', '.join(sets)} WHERE group_name=%s", args)
    return get_account(group_name)


def list_accounts():
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT * FROM billing_accounts ORDER BY group_name")
        return _rows(cur)


def _apply_balance(cur, group_name, delta_cents):
    """Move the cached balance by ``delta`` and return the new value."""
    cur.execute(
        "UPDATE billing_accounts SET balance_cents = balance_cents + %s WHERE group_name=%s",
        (int(delta_cents), group_name),
    )
    cur.execute("SELECT balance_cents FROM billing_accounts WHERE group_name=%s", (group_name,))
    row = cur.fetchone()
    return int(row["balance_cents"]) if row else None


# ── money movements ──────────────────────────────────────────────
def credit_topup(group_name, amount_cents, out_trade_no, note="", actor=""):
    """Credit a paid top-up exactly once (keyed by ``out_trade_no``).

    Returns the new balance on success, or ``None`` when this ``out_trade_no``
    was already settled — the caller should treat None as "already done", not
    as an error (this is what makes a replayed payment callback a no-op).
    """
    ensure_schema()
    cents = int(amount_cents)
    if cents <= 0:
        raise ValueError("充值金额必须为正")
    ensure_account(group_name)
    with tx() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT IGNORE INTO billing_ledger
                   (group_name, kind, amount_cents, out_trade_no, note, actor)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (group_name, KIND_TOPUP, cents, out_trade_no, note or "", actor or ""),
        )
        if cur.rowcount == 0:
            return None  # duplicate out_trade_no — already credited
        bal = _apply_balance(cur, group_name, cents)
        cur.execute("UPDATE billing_ledger SET balance_after=%s WHERE out_trade_no=%s",
                    (bal, out_trade_no))
    return bal


def adjust(group_name, amount_cents, note="", actor=""):
    """Manual correction (signed cents).  Always applies."""
    ensure_schema()
    cents = int(amount_cents)
    ensure_account(group_name)
    with tx() as cn, cn.cursor() as cur:
        cur.execute(
            """INSERT INTO billing_ledger (group_name, kind, amount_cents, note, actor)
               VALUES (%s, %s, %s, %s, %s)""",
            (group_name, KIND_ADJUSTMENT, cents, note or "", actor or ""),
        )
        bal = _apply_balance(cur, group_name, cents)
        cur.execute("UPDATE billing_ledger SET balance_after=%s WHERE id=LAST_INSERT_ID()",
                    (bal,))
    return bal


def charge_period(group_name, period_start, period_end, rows, actor="", note=""):
    """Charge one closed period from ``billing_core.breakdown`` rows.

    Idempotent per ``(group, period, resource_key)``: rows already present in
    ``billing_charges`` are skipped, so re-running settlement for a period that
    already settled is free.  Returns the total cents newly charged (0 when the
    period was already settled, or had no billable usage).
    """
    ensure_schema()
    ensure_account(group_name)
    ps, pe = int(period_start), int(period_end)
    charged = 0
    with tx() as cn, cn.cursor() as cur:
        for r in rows:
            cents = int(r.get("cost_cents") or 0)
            if cents == 0:
                continue
            key = r["resource_key"]
            cur.execute(
                """INSERT IGNORE INTO billing_charges
                       (group_name, period_start, period_end, resource_key, cost_cents)
                   VALUES (%s, %s, %s, %s, %s)""",
                (group_name, ps, pe, key, cents),
            )
            if cur.rowcount == 0:
                continue  # already charged for this key+period
            charged += cents
            cur.execute(
                """INSERT INTO billing_ledger
                       (group_name, kind, amount_cents, resource_key, units,
                        unit_price_cents, period_start, period_end, note, actor)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (group_name, KIND_CHARGE, -cents, key, float(r.get("units") or 0),
                 float(r.get("unit_price_cents") or 0), ps, pe, note or "", actor or ""),
            )
        if charged:
            _apply_balance(cur, group_name, -charged)
    return charged


def last_settled():
    """Highest ``period_end`` ever charged, or None (nothing settled yet)."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute("SELECT MAX(period_end) AS m FROM billing_charges")
        row = cur.fetchone()
    return int(row["m"]) if row and row["m"] is not None else None


def ledger(group_name, limit=100, offset=0):
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            """SELECT id, kind, amount_cents, resource_key, units, unit_price_cents,
                      period_start, period_end, out_trade_no, note, actor, created_at
               FROM billing_ledger WHERE group_name=%s
               ORDER BY id DESC LIMIT %s OFFSET %s""",
            (group_name, int(limit), int(offset)),
        )
        return _rows(cur)


def recompute_balance(group_name):
    """Re-derive the cached balance from the ledger (repair / audit)."""
    ensure_schema()
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            "SELECT COALESCE(SUM(amount_cents),0) AS s FROM billing_ledger WHERE group_name=%s",
            (group_name,),
        )
        total = int((cur.fetchone() or {}).get("s") or 0)
        cur.execute("UPDATE billing_accounts SET balance_cents=%s WHERE group_name=%s",
                    (total, group_name))
    return total


# ── enforcement gate ─────────────────────────────────────────────
def balance_ratio(account):
    """Fraction of the credit limit still available, or None if no limit."""
    if not account:
        return None
    limit = int(account.get("credit_limit_cents") or 0)
    if limit <= 0:
        return None
    return int(account.get("balance_cents") or 0) / limit


def is_blocked(group_name):
    """Read-only gate: should this group's workloads be held back?

    Blocking is driven by an explicit account *status*, never by a momentary
    balance — the tiered policy (warn → degrade → stop) is applied by the
    settlement loop, which suspends an account only after sustained arrears.
    That keeps a transient dip from stopping a running pod.
    """
    acct = get_account(group_name)
    if not acct or not int(acct.get("billable") or 0):
        return False
    return acct.get("status") in (STATUS_SUSPENDED, STATUS_CLOSED)


def income_summary(since_epoch=None):
    """Rough income / outflow totals for the admin dashboard."""
    ensure_schema()
    where, args = "", []
    if since_epoch is not None:
        where = "WHERE created_at >= FROM_UNIXTIME(%s)"
        args.append(int(since_epoch))
    with users._conn() as cn, cn.cursor() as cur:
        cur.execute(
            f"""SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total
                FROM billing_ledger {where} GROUP BY kind""",
            args,
        )
        by_kind = {r["kind"]: {"count": int(r["n"]), "total_cents": int(r["total"])}
                   for r in _rows(cur)}
    return by_kind
