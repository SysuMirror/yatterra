#!/usr/bin/env python3
"""Settlement daemon: turn metered usage into ledger charges, hourly.

Every closed hour, for every billable group, this daemon multiplies that hour's
physical usage (from ``usage_store``'s hourly buckets) by the current unit
prices and posts the result to the money layer as an idempotent charge.  It is
the only thing that moves money *out* of a balance on a schedule; top-ups move
money in and arrive over HTTP (see ``pay.py``).

Why hourly *closed* buckets, and not the raw 30s samples:

- the raw table only keeps 48h, so settling from it would leave a gap after any
  restart longer than that; the hourly buckets are kept 400 days and are
  recomputed from source, so they are both durable and self-healing;
- a bucket must be *closed* (its hour fully elapsed) before it is billed, or a
  partially-populated hour would be charged early and (being idempotent) never
  corrected.

Crash/restart safety comes from the charge being keyed by
``(group, period, resource)`` in ``billing_charges``: re-settling an hour that
partially succeeded only charges the keys that did not land.

The daemon never suspends an account on its own unless
``YATTERRA_BILLING_AUTO_SUSPEND=1``; by default it warns (push + notification)
and leaves the enforcement decision to an operator via the admin API.
"""
import argparse
import fcntl
import os
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import logutil  # noqa: E402
import siteconf  # noqa: E402
from usage_store import UsageStore, HOUR, hour_of  # noqa: E402

LOG = siteconf.path("billing_settle.log")

# Consecutive settle runs an account may sit below zero before the opt-in
# auto-suspend fires.  Only consulted when YATTERRA_BILLING_AUTO_SUSPEND is on.
_BELOW_ZERO = {}
BELOW_ZERO_RUNS = 3


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _auto_suspend_enabled():
    return os.environ.get("YATTERRA_BILLING_AUTO_SUSPEND", "").strip().lower() in ("1", "true", "yes", "on")


def settle_hours(since, until, actor="settle", dry_run=False):
    """Charge every closed hour bucket in ``[since, until)``.

    Returns ``{"hours": n, "charged_cents": n, "groups": n}``.  ``since``/``until``
    are epoch seconds; only hours that have fully elapsed are considered.
    """
    import billing_core
    import billing_store

    store = UsageStore()
    now_hour = hour_of(time.time())
    until = min(int(until), now_hour)          # never bill the in-progress hour
    h = hour_of(since)
    prices = billing_store.get_prices()
    charged = 0
    groups = set()
    hours = 0
    while h < until:
        _series, per_group = store.summary(h, h + HOUR, "hour")
        hours += 1
        for row in per_group:
            g = row.get("group_name")
            if not g:
                continue
            acct = billing_store.get_account(g)
            if acct is not None and not int(acct.get("billable") or 0):
                continue
            rows = billing_core.breakdown(row, prices)
            cost = sum(r["cost_cents"] for r in rows)
            if cost <= 0:
                continue
            groups.add(g)
            if dry_run:
                charged += cost
                continue
            charged += billing_store.charge_period(
                g, h, h + HOUR, rows, actor=actor,
                note=f"hour {time.strftime('%Y-%m-%d %H:%M', time.localtime(h))}")
        h += HOUR
    return {"hours": hours, "charged_cents": charged, "groups": len(groups)}


def settle_range(since=None, until=None, actor="settle", dry_run=False):
    """Settle from the last settled hour (or ``since``) up to ``until`` (now)."""
    import billing_store
    now = int(until or time.time())
    if since is None:
        since = billing_store.last_settled() or (now - 2 * HOUR)
        # last_settled() is a period_end (exclusive); start there
    if int(since) >= hour_of(now):
        return {"hours": 0, "charged_cents": 0, "groups": 0}
    return settle_hours(int(since), now, actor=actor, dry_run=dry_run)


# ── tiered enforcement ───────────────────────────────────────────
def enforce(accounts=None):
    """Warn / (optionally) suspend accounts that are out of credit.

    Tiering: below ``warn_ratio`` of the credit limit → one push per state
    change; at or below zero → alert, and after ``BELOW_ZERO_RUNS`` consecutive
    runs suspend — but only when auto-suspend is explicitly enabled.
    """
    import billing_store
    import billing_core  # noqa: F401  (kept for symmetry / future use)

    out = {"warned": [], "suspended": []}
    rows = accounts if accounts is not None else billing_store.list_accounts()
    auto = _auto_suspend_enabled()
    for acct in rows:
        g = acct.get("group_name")
        if not g or not int(acct.get("billable") or 0):
            continue
        if acct.get("status") == billing_store.STATUS_CLOSED:
            continue
        balance = int(acct.get("balance_cents") or 0)
        ratio = billing_store.balance_ratio(acct)
        if balance <= 0:
            _BELOW_ZERO[g] = _BELOW_ZERO.get(g, 0) + 1
        else:
            _BELOW_ZERO.pop(g, None)
        if balance <= 0:
            _notify_low(g, balance, ratio, severe=True)
            out["warned"].append(g)
            if auto and _BELOW_ZERO.get(g, 0) >= BELOW_ZERO_RUNS \
                    and acct.get("status") == billing_store.STATUS_ACTIVE:
                billing_store.set_account(g, status=billing_store.STATUS_SUSPENDED)
                out["suspended"].append(g)
                log(f"auto-suspend {g} balance={balance}")
        elif ratio is not None and ratio < float(acct.get("warn_ratio") or 0.2):
            _notify_low(g, balance, ratio, severe=False)
            out["warned"].append(g)
    return out


def _notify_low(group, balance, ratio, severe):
    """One notification per (group, state) — notify_event dedupes by key."""
    try:
        import pwa_alerts
        yuan = balance / 100.0
        tip = "已欠费" if severe else "余额偏低"
        body = (f"组「{group}」{tip}：当前余额 ¥{yuan:.2f}"
                + (f"（额度使用 {ratio * 100:.0f}%）" if ratio is not None else "")
                + "。请及时充值，否则资源可能被降级或停机。")
        state = "zero" if severe else "low"
        pwa_alerts.notify_event(
            f"billing-low:{group}:{state}", group,
            f"余额不足提醒 · {group}", body,
            url=f"/pods/{group}", kind="billing-low",
        )
    except Exception as exc:
        log(f"notify failed group={group}: {type(exc).__name__}: {exc}")


def run_once(actor="settle"):
    res = settle_range(actor=actor)
    enf = enforce()
    log(f"settle ok hours={res['hours']} charged={res['charged_cents']}c "
        f"groups={res['groups']} warned={len(enf['warned'])} suspended={len(enf['suspended'])}")
    return res


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="settle once and exit")
    parser.add_argument("--interval", type=int, default=HOUR, help="seconds between runs")
    parser.add_argument("--since", type=int, default=None, help="epoch start (catch-up)")
    parser.add_argument("--until", type=int, default=None, help="epoch end")
    parser.add_argument("--dry-run", action="store_true", help="compute but do not charge")
    args = parser.parse_args()

    os.umask(0o027)
    lock_path = siteconf.path("billing_settle.lock")
    Path(lock_path).parent.mkdir(parents=True, exist_ok=True)

    with open(lock_path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Another billing settle worker owns this lock\n")

        if args.dry_run or args.since is not None or args.until is not None:
            res = settle_range(args.since, args.until, dry_run=args.dry_run)
            log(f"settle(dry={args.dry_run}) hours={res['hours']} "
                f"charged={res['charged_cents']}c groups={res['groups']}")
            return

        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())

        log(f"billing_settle start interval={args.interval}s "
            f"auto_suspend={_auto_suspend_enabled()}")
        while not stop.is_set():
            started = time.monotonic()
            try:
                run_once()
            except Exception as exc:
                log(f"settle failed: {type(exc).__name__}: {exc}")
                if args.once:
                    raise
            if args.once:
                break
            stop.wait(max(5, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
