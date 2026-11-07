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

By default the daemon **suspends** a Pod that has been at or below zero credit
for ``BELOW_ZERO_RUNS`` consecutive runs (after warning it: push + notification).
Set ``YATTERRA_BILLING_AUTO_SUSPEND=0`` to make it warn-only and leave the
enforcement decision to an operator via the admin API.

Charges come out of each Pod's own quota (``billing_accounts``); the owner's
wallet (``wallet``) is only debited when they *allocate* to the pod.  So a pod
runs dry on its own allocation, independently of every other pod.
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

# Consecutive settle runs an account may sit below zero before auto-suspend
# fires.  Only consulted when auto-suspend is on (which it is by default).
_BELOW_ZERO = {}
BELOW_ZERO_RUNS = 3

# 余额不足提醒的「重新武装」窗口: 同一 (组, 档位) 每 COOLDOWN_S 最多提醒一次。
# 事件键带窗口号, 所以充值后再次欠费会在新窗口重新提醒(旧的是一次性、永不再报)。
LOW_COOLDOWN_S = int(os.environ.get("YATTERRA_BILLING_LOW_COOLDOWN", "21600"))


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _auto_suspend_enabled():
    """Auto-suspend at zero is the deployment default; only 0/false/no/off disables.

    (Charges are per-pod and allocation is explicit, so "suspend when the pod's
    own quota hits zero" is the intended product behaviour — not an opt-in.)
    """
    val = os.environ.get("YATTERRA_BILLING_AUTO_SUSPEND", "1").strip().lower()
    return val not in ("0", "false", "no", "off")


def settle_hours(since, until, actor="settle", dry_run=False):
    """Charge every closed hour bucket in ``[since, until)``.

    Returns ``{"hours": n, "charged_cents": n, "groups": n}``.  ``since``/``until``
    are epoch seconds; only hours that have fully elapsed are considered.
    """
    import billing_core
    import billing_store
    import groups

    internal = groups.internal_groups()   # 平台内部组 → 免计费(黑名单模式)
    store = UsageStore()
    now_hour = hour_of(time.time())
    until = min(int(until), now_hour)          # never bill the in-progress hour
    h = hour_of(since)
    prices = billing_store.get_prices()
    charged = 0
    charged_groups = set()
    hours = 0
    while h < until:
        _series, per_group = store.summary(h, h + HOUR, "hour")
        hours += 1
        for row in per_group:
            g = row.get("group_name")
            if not g:
                continue
            if g in internal:
                continue          # 内部组不计费
            acct = billing_store.get_account(g)
            if acct is not None and not int(acct.get("billable") or 0):
                continue
            rows = billing_core.breakdown(row, prices)
            cost = sum(r["cost_cents"] for r in rows)
            if cost <= 0:
                continue
            charged_groups.add(g)
            if dry_run:
                charged += cost
                continue
            charged += billing_store.charge_period(
                g, h, h + HOUR, rows, actor=actor,
                note=f"hour {time.strftime('%Y-%m-%d %H:%M', time.localtime(h))}")
        h += HOUR
    return {"hours": hours, "charged_cents": charged, "groups": len(charged_groups)}


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
    runs suspend the pod (auto-suspend is on by default; set
    ``YATTERRA_BILLING_AUTO_SUSPEND=0`` for warn-only).
    """
    import billing_store
    import billing_core  # noqa: F401  (kept for symmetry / future use)
    import groups

    internal = groups.internal_groups()
    out = {"warned": [], "suspended": []}
    rows = accounts if accounts is not None else billing_store.list_accounts()
    auto = _auto_suspend_enabled()
    for acct in rows:
        g = acct.get("group_name")
        if not g or not int(acct.get("billable") or 0):
            continue
        if g in internal:
            continue          # 内部组不提醒、不停机
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
    """At most one notification per (group, state) per LOW_COOLDOWN_S window.

    The event key carries a rolling window number, so a group that stays low is
    re-warned each window, and one that tops up then dips again is warned afresh
    (the old key was one-shot forever).
    """
    try:
        import pwa_alerts
        yuan = balance / 100.0
        tip = "已欠费" if severe else "余额偏低"
        body = (f"组「{group}」{tip}：当前余额 ¥{yuan:.2f}"
                + (f"（额度使用 {ratio * 100:.0f}%）" if ratio is not None else "")
                + "。请及时充值，否则资源可能被降级或停机。")
        if severe:
            wallet_hint = _wallet_hint(group)
            if wallet_hint:
                body += wallet_hint
        state = "zero" if severe else "low"
        window = int(time.time() // max(LOW_COOLDOWN_S, 1))
        pwa_alerts.notify_event(
            f"billing-low:{group}:{state}:{window}", group,
            f"余额不足提醒 · {group}", body,
            url=f"/billing?group={group}", kind="billing-low",
        )
    except Exception as exc:
        log(f"notify failed group={group}: {type(exc).__name__}: {exc}")


def _wallet_hint(group, max_show=3):
    """Best-effort suffix pointing the owner(s) at their wallet, for the zero state.

    Money now lives in a per-user wallet and must be *allocated* to this pod, so a
    zero balance is often "wallet still has funds, pod was never topped up".
    Returns "" when nothing useful can be read (never raises).
    """
    try:
        import groups
        import wallet
        owners = (groups.load_state()["groups"].get(group) or {}).get("owners") or []
        parts = []
        for name in owners[:max_show]:
            acct = wallet.get_account(name)
            if not acct:
                continue
            parts.append(f"{name} ¥{int(acct.get('balance_cents') or 0) / 100.0:.2f}")
        if not parts:
            return ""
        tail = " 等" if len(owners) > max_show else ""
        return (f"（所属人钱包余额：{' · '.join(parts)}{tail}，"
                "可在「我的 Pod 额度」把钱包额度分配给该 Pod。）")
    except Exception:
        return ""


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
