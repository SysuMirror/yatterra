"""Usage / billing API blueprint — /api/billing

Two halves:

- **usage** (physical) — reads the metering DB (``usage_store``) and returns
  core-hour / card-hour / GiB-hour reports.  Derived units are computed here
  from the stored second-integrals, never persisted.
- **money** — prices, per-group balances, cost estimates and the ledger, from
  ``billing_store`` (MySQL).  All money is integer cents.

Scopes: per group/pod endpoints are member-scoped (a group sees its own bill);
platform-wide and price/account administration are admin (``ops.audit`` for the
summary, ``billing.price`` / ``billing.account`` for writes).

The money endpoints degrade gracefully: if MySQL is unreachable the usage
endpoints still answer, with ``cost``/``account`` omitted rather than 500.
"""
import time

from flask import Blueprint, request, jsonify, g

from api._auth import require_auth, require_pod
from usage_store import UsageStore, HOUR, DAY

try:
    import billing_core
    import billing_store
except Exception:  # pragma: no cover - only breaks if the module is missing
    billing_core = None
    billing_store = None

try:
    import wallet
except Exception:  # pragma: no cover
    wallet = None

billing_bp = Blueprint("api_billing", __name__, url_prefix="/api/billing")

_RANGES = {"24h": 24 * HOUR, "7d": 7 * DAY, "30d": 30 * DAY}
_DEFAULT_RANGE = "7d"


def _window(range_key):
    """Return (since, until) epoch seconds for a range key (until = now)."""
    span = _RANGES.get(range_key) or _RANGES[_DEFAULT_RANGE]
    until = time.time()
    return until - span, until


def _bucket():
    b = request.args.get("bucket", "hour")
    return b if b in ("hour", "day") else "hour"


@billing_bp.route("/pods/<name>", methods=["GET"])
@require_pod("member")
def pod_usage(name):
    """Per-group usage series over ``range`` (24h|7d|30d), bucketed hour|day."""
    range_key = request.args.get("range", _DEFAULT_RANGE)
    bucket = _bucket()
    since, until = _window(range_key)
    store = UsageStore()
    series = store.series(name, since, until, bucket=bucket)
    totals = _totals(series)
    # trailing bucket is partial if it does not span a full hour/day of samples
    span = HOUR if bucket == "hour" else DAY
    partial = bool(series) and series[-1]["n_samples"] * _tick_seconds() < span
    return jsonify({
        "group": name,
        "range": range_key,
        "bucket": bucket,
        "since": since,
        "until": until,
        "partial": partial,
        "series": series,
        "totals": totals,
        "cost": _cost_block(totals),
    })


@billing_bp.route("/summary", methods=["GET"])
@require_auth("ops.audit")
def platform_summary():
    """Platform-wide totals + per-group rollup over ``range``."""
    range_key = request.args.get("range", _DEFAULT_RANGE)
    bucket = _bucket()
    since, until = _window(range_key)
    store = UsageStore()
    series, per_group = store.summary(since, until, bucket=bucket)
    return jsonify({
        "range": range_key,
        "bucket": bucket,
        "since": since,
        "until": until,
        "series": series,
        "per_group": per_group,
        "totals": _totals(series),
    })


def _tick_seconds():
    """Metering tick ~= 30s (only used to flag a partial trailing bucket)."""
    return 30


def _prices():
    """Current price map, or an all-zero map if the money layer is offline."""
    if not billing_store:
        return {k: 0.0 for k in (billing_core.RESOURCE_KEYS if billing_core else ())}
    try:
        return billing_store.get_prices()
    except Exception:
        return {k: 0.0 for k in billing_core.RESOURCE_KEYS}


def _cost_block(totals, basis="actual"):
    """Cost estimate for a totals dict; None when the money layer is offline."""
    if not billing_core:
        return None
    try:
        prices = _prices()
        return {
            "basis": basis,
            "prices": prices,
            "rows": billing_core.breakdown(totals, prices, basis),
            "total_cents": billing_core.cost_cents(totals, prices, basis)["total_cents"],
        }
    except Exception:
        return None


def _totals(series):
    """Sum the derived core-hours/card-hours across a series."""
    def s(key):
        return round(sum(r.get(key) or 0 for r in series), 4)
    cores = s("core_hours")
    req = s("request_core_hours")
    return {
        "core_hours": cores,
        "request_core_hours": req,
        "gap_core_hours": round(req - cores, 4),
        "gpu_mem_gib_hours": s("gpu_mem_gib_hours"),
        "compute_card_hours": s("compute_card_hours"),
        "mem_gib_hours": s("mem_gib_hours"),
        "storage_home_gib_hours": s("storage_home_gib_hours"),
        "storage_minio_gib_hours": s("storage_minio_gib_hours"),
        "storage_quota_gib_hours": s("storage_quota_gib_hours"),
        "cpu_utilization": round(cores / req, 4) if req > 0 else None,
    }


# ── money: per-group account / ledger ────────────────────────────
def _money_ready():
    if not billing_store:
        return jsonify({"error": {"code": "UNAVAILABLE",
                                  "message": "计费资金层不可用"}}), 503
    return None


@billing_bp.route("/account/<name>", methods=["GET"])
@require_pod("member")
def group_account(name):
    """Balance + recent ledger for one group (its own members may read it)."""
    if (bad := _money_ready()):
        return bad
    try:
        billing_store.ensure_account(name)
        acct = billing_store.get_account(name)
        ledger = billing_store.ledger(name, limit=int(request.args.get("limit", 50)))
        return jsonify({
            "group": name,
            "account": acct,
            "balance_ratio": billing_store.balance_ratio(acct),
            "blocked": billing_store.is_blocked(name),
            "ledger": ledger,
        })
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500


@billing_bp.route("/prices", methods=["GET"])
@require_auth(min_role="user")
def get_prices():
    """Current unit prices (readable by any signed-in user)."""
    if (bad := _money_ready()):
        return bad
    return jsonify({
        "prices": _prices(),
        "labels": billing_core.RESOURCE_LABELS,
        "keys": list(billing_core.RESOURCE_KEYS),
    })


# ── money: admin ─────────────────────────────────────────────────
@billing_bp.route("/admin/prices", methods=["POST"])
@require_auth("billing.price")
def set_prices():
    """Update one or more unit prices: ``{prices: {resource_key: cents}}``."""
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    prices = body.get("prices") or {}
    if not isinstance(prices, dict) or not prices:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 prices"}}), 400
    unknown = [k for k in prices if k not in billing_core.RESOURCE_KEYS]
    if unknown:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": f"未知资源: {', '.join(unknown)}"}}), 400
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    try:
        for k, v in prices.items():
            billing_store.set_price(k, v, actor=actor)
    except (TypeError, ValueError) as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    _audit("billing_price_set", f"prices={prices}", actor)
    return jsonify({"ok": True, "prices": _prices()})


@billing_bp.route("/admin/accounts", methods=["GET"])
@require_auth("billing.account")
def list_accounts():
    if (bad := _money_ready()):
        return bad
    return jsonify({"accounts": _with_internal(billing_store.list_accounts())})


def _with_internal(accounts):
    """Annotate each account row with the group's `internal` flag (平台内部组)."""
    try:
        import groups
        internal = groups.internal_groups()
    except Exception:
        internal = set()
    return [dict(a, internal=(a.get("group_name") in internal)) for a in accounts]


@billing_bp.route("/admin/accounts/bulk", methods=["POST"])
@require_auth("billing.account")
def bulk_accounts():
    """Batch-classify groups or set the billable flag.

    Body: ``{"groups": ["a","b"], "internal": true|false, "billable": 0|1}``
    (any subset).  ``internal=true`` marks 平台内部组 and turns OFF billing for
    them (creates a billable=0 account row if absent); un-marking does **not**
    auto re-enable billing.  ``billable`` is the per-account override for groups
    that stay external.
    """
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    names = body.get("groups") or []
    if not isinstance(names, list) or not names:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": "groups 须为非空数组"}}), 400
    has_internal = "internal" in body
    has_billable = "billable" in body
    if not has_internal and not has_billable:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": "须提供 internal 或 billable"}}), 400
    import groups
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    done, errors = [], []
    for raw in names:
        name = (raw or "").strip()
        if not name:
            continue
        try:
            if has_internal:
                flag = bool(body.get("internal"))
                groups.set_internal(name, flag)
                if flag:
                    billing_store.ensure_account(name, billable=0)
            if has_billable:
                billing_store.set_account(name, billable=int(body.get("billable")))
            done.append(name)
        except (ValueError, TypeError) as exc:
            errors.append({"group": name, "error": str(exc)})
    _audit("billing_accounts_bulk",
           f"n={len(done)} internal={body.get('internal')} billable={body.get('billable')}",
           actor)
    return jsonify({"ok": True, "updated": done, "errors": errors})


@billing_bp.route("/admin/accounts/<name>", methods=["POST"])
@require_auth("billing.account")
def set_account(name):
    """Admin override: status / billable / credit limit for one group."""
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    try:
        acct = billing_store.set_account(
            name,
            status=body.get("status"),
            billable=body.get("billable"),
            credit_limit_cents=body.get("credit_limit_cents"),
        )
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    _audit("billing_account_set", f"group={name} body={body}", actor)
    return jsonify({"ok": True, "account": acct})


@billing_bp.route("/admin/adjust", methods=["POST"])
@require_auth("billing.account")
def adjust_balance():
    """Signed manual correction: ``{group, amount_cents, note}``."""
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    group = (body.get("group") or "").strip()
    if not group:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 group"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    balance = billing_store.adjust(group, cents, note=body.get("note") or "", actor=actor)
    _audit("billing_adjust", f"group={group} amount={cents}", actor)
    return jsonify({"ok": True, "balance_cents": balance})


@billing_bp.route("/admin/settle", methods=["POST"])
@require_auth("billing.account")
def run_settle():
    """Manually settle closed hours (catch-up after downtime).  Idempotent."""
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    actor = (getattr(g, "api_user", None) or {}).get("username") or "admin"
    try:
        import billing_settle
        res = billing_settle.settle_range(
            since=body.get("since"), until=body.get("until"),
            actor=actor, dry_run=bool(body.get("dry_run")),
        )
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    _audit("billing_settle_run", f"since={body.get('since')} until={body.get('until')}", actor)
    return jsonify({"ok": True, **res})


@billing_bp.route("/admin/income", methods=["GET"])
@require_auth("billing.account")
def income():
    """Ledger totals by kind (income vs. consumption)."""
    if (bad := _money_ready()):
        return bad
    since = request.args.get("since")
    return jsonify({"by_kind": billing_store.income_summary(int(since) if since else None)})


# ── money: per-user wallet + pod allocation ──────────────────────
def _wallet_ready():
    if not billing_store or not wallet:
        return jsonify({"error": {"code": "UNAVAILABLE",
                                  "message": "计费资金层不可用"}}), 503
    return None


def _caller():
    return getattr(g, "api_user", None) or {}


def _caller_name():
    return _caller().get("username") or ""


def _is_admin(user):
    return (user or {}).get("role") in ("admin", "super")


def _gen_transfer_token():
    """Idempotency key for one wallet↔pod transfer (client may supply its own)."""
    import os
    n = int(time.time() * 1000)
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return "TR" + (b36 or "0") + os.urandom(3).hex().upper()


def _visible_pods(user):
    """Pods the caller may allocate to: their own (owner/member); admins see all
    外部(billable) groups.  Each entry carries the pod quota balance/status."""
    import groups
    import users
    try:
        state = groups.load_state().get("groups", {})
        internal = groups.internal_groups()
    except Exception:
        return []
    out = []
    for name, pod in state.items():
        if _is_admin(user):
            if name in internal:
                continue
            role = "owner"
        else:
            role = users.pod_role(user, pod)
            if not role:
                continue
        acct = billing_store.get_account(name) or {}
        out.append({
            "name": name,
            "my_role": role,
            "balance_cents": int(acct.get("balance_cents") or 0),
            "status": acct.get("status"),
            "billable": int(acct.get("billable") or 0),
        })
    out.sort(key=lambda p: p["name"])
    return out


@billing_bp.route("/wallet", methods=["GET"])
@require_auth(min_role="user")
def wallet_home():
    """The caller's own wallet + the pods they can fund (no path param → no IDOR)."""
    if (bad := _wallet_ready()):
        return bad
    user = _caller()
    username = user.get("username")
    if not username:
        return jsonify({"error": {"code": "UNAUTHORIZED", "message": "未登录"}}), 401
    try:
        acct = wallet.get_account(username)
        if acct is None:
            acct = {"username": username, "balance_cents": 0, "credit_limit_cents": 0,
                    "status": "active", "warn_ratio": 0.2}
        return jsonify({
            "username": username,
            "account": acct,
            "balance_ratio": wallet.balance_ratio(acct),
            "ledger": wallet.ledger(username, limit=int(request.args.get("limit", 50))),
            "pods": _visible_pods(user),
        })
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500


def _check_pod_target(user, group):
    """Returns (pod, error_response).  Admins bypass the membership check."""
    import groups
    import users
    try:
        pod = groups.load_state().get("groups", {}).get(group)
    except Exception:
        pod = None
    if not pod:
        return None, (jsonify({"error": {"code": "NOT_FOUND", "message": "组不存在"}}), 404)
    if not _is_admin(user) and users.pod_role(user, pod) not in ("owner", "member"):
        return None, (jsonify({"error": {"code": "FORBIDDEN",
                                         "message": f"不是 Pod {group} 的成员"}}), 403)
    return pod, None


@billing_bp.route("/allocate", methods=["POST"])
@require_auth("billing.allocate")
def allocate():
    """Move cents from the caller's wallet into a pod they belong to.

    ``{group, amount_cents, note?, token?}``.
    """
    if (bad := _wallet_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    group = str(body.get("group") or "").strip()
    if not group:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 group"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    if cents <= 0:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "分配金额必须为正"}}), 400
    user = _caller()
    username = _caller_name()
    _, err = _check_pod_target(user, group)
    if err:
        return err
    if wallet.is_frozen(username):
        return jsonify({"error": {"code": "FORBIDDEN", "message": "钱包已冻结"}}), 403
    token = str(body.get("token") or "").strip() or _gen_transfer_token()
    try:
        bal = wallet.transfer_to_pod(group, username, cents, token=token,
                                     note=body.get("note") or "", actor=username)
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    _audit("billing_allocate", f"user={username} group={group} amount={cents} token={token}", username)
    return jsonify({"ok": True, "balance_cents": bal, "reused": bal is None})


@billing_bp.route("/deallocate", methods=["POST"])
@require_auth("billing.account")
def deallocate():
    """Admin-only reclaim: move unused pod quota back to a *specified* user's
    wallet.  ``{username, group, amount_cents, note?, token?}``."""
    if (bad := _wallet_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    group = str(body.get("group") or "").strip()
    username = str(body.get("username") or "").strip()
    if not group or not username:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 group 或 username"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    token = str(body.get("token") or "").strip() or _gen_transfer_token()
    actor = _caller_name()
    try:
        bal = wallet.transfer_from_pod(group, username, cents, token=token,
                                       note=body.get("note") or "", actor=actor)
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    _audit("billing_deallocate", f"user={username} group={group} amount={cents} token={token}", actor)
    return jsonify({"ok": True, "balance_cents": bal, "reused": bal is None})


@billing_bp.route("/admin/wallets", methods=["GET"])
@require_auth("billing.account")
def admin_wallets():
    if (bad := _wallet_ready()):
        return bad
    rows = wallet.list_accounts()
    labels = {}
    try:
        import users as users_mod
        labels = users_mod.user_labels([r.get("username") for r in rows])
    except Exception:
        labels = {}
    return jsonify({"wallets": [dict(r, label=labels.get(r.get("username"), "")) for r in rows]})


@billing_bp.route("/admin/wallets/<username>", methods=["POST"])
@require_auth("billing.account")
def admin_wallet_set(username):
    """Admin override: wallet status / credit limit."""
    if (bad := _wallet_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    actor = _caller_name()
    try:
        acct = wallet.set_account(username, status=body.get("status"),
                                  credit_limit_cents=body.get("credit_limit_cents"))
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    _audit("wallet_set", f"user={username} body={body}", actor)
    return jsonify({"ok": True, "account": acct})


@billing_bp.route("/admin/wallet/adjust", methods=["POST"])
@require_auth("billing.account")
def admin_wallet_adjust():
    """Signed manual wallet correction: ``{username, amount_cents, note}``."""
    if (bad := _wallet_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    username = str(body.get("username") or "").strip()
    if not username:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 username"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    actor = _caller_name()
    balance = wallet.adjust(username, cents, note=body.get("note") or "", actor=actor)
    _audit("wallet_adjust", f"user={username} amount={cents}", actor)
    return jsonify({"ok": True, "balance_cents": balance})


@billing_bp.route("/admin/allocate", methods=["POST"])
@require_auth("billing.account")
def admin_allocate():
    """Admin transfer on behalf: ``{username, group, amount_cents, direction}``."""
    if (bad := _wallet_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    group = str(body.get("group") or "").strip()
    username = str(body.get("username") or "").strip()
    direction = str(body.get("direction") or "in").strip()
    if not group or not username:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 group 或 username"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    actor = _caller_name()
    token = str(body.get("token") or "").strip() or _gen_transfer_token()
    try:
        if direction == "out":
            bal = wallet.transfer_from_pod(group, username, cents, token=token,
                                           note=body.get("note") or "", actor=actor)
        else:
            bal = wallet.transfer_to_pod(group, username, cents, token=token,
                                         note=body.get("note") or "", actor=actor)
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    _audit("billing_admin_allocate",
           f"user={username} group={group} dir={direction} amount={cents}", actor)
    return jsonify({"ok": True, "balance_cents": bal, "reused": bal is None})


def _audit(action, detail, actor):
    """Best-effort audit trail; never fails the request."""
    try:
        import audit
        audit.record(action, detail=detail, actor=actor or "")
    except Exception:
        pass
