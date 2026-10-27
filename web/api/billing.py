"""Usage / billing API blueprint — /api/billing

Reads the usage metering DB (``usage_store``) and returns core-hour / card-hour
reports.  Two scopes:

- per group/pod: ``GET /api/billing/pods/<name>`` — member-scoped (the pod's
  own group can see its bill).
- platform-wide: ``GET /api/billing/summary`` — admin/super only (``ops.audit``).

Units are core-hours / card-hours; no money is involved.  Derived units are
computed here from the stored second-integrals, never persisted.
"""
import time

from flask import Blueprint, request, jsonify

from api._auth import require_auth, require_pod
from usage_store import UsageStore, HOUR, DAY

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
        "cpu_utilization": round(cores / req, 4) if req > 0 else None,
    }
