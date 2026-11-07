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
    return jsonify({"accounts": billing_store.list_accounts()})


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


def _audit(action, detail, actor):
    """Best-effort audit trail; never fails the request."""
    try:
        import audit
        audit.record(action, detail=detail, actor=actor or "")
    except Exception:
        pass
