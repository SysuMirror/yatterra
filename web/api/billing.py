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
import re
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


@billing_bp.route("/accounts/mine", methods=["GET"])
@require_auth(min_role="user")
def my_accounts():
    """Balances/status for every group the caller can see — one request, one query.

    Replaces the per-group ``GET /account/<name>`` fan-out the 计费总览 page used
    to issue (N round-trips, each lazily creating an account row).  Visibility
    follows ``GET /api/pods``: a user sees the groups they own or belong to;
    admins see all.  Group names without an account row read as ¥0 / 正常.
    """
    if (bad := _money_ready()):
        return bad
    import users
    u = _caller()
    is_admin = u.get("role") in ("super", "admin")
    try:
        state = _load_groups()
    except Exception:
        return jsonify({"error": {"code": "ERROR", "message": "组状态不可用"}}), 500
    internal = {n for n, g in state.items() if g.get("internal")}
    rows = {r["group_name"]: r for r in billing_store.list_accounts()}
    out = []
    for name in sorted(state.keys()):
        if not is_admin and users.pod_role(u, state[name]) is None:
            continue
        acct = rows.get(name) or {}
        status = acct.get("status") or "active"
        # no row ⇒ default (计费开), matching _merge_groups / ensure_account
        billable = int(acct.get("billable") or 0) if acct else 1
        out.append({
            "group": name,
            "balance_cents": int(acct.get("balance_cents") or 0),
            "credit_limit_cents": int(acct.get("credit_limit_cents") or 0),
            "status": status,
            "billable": billable,
            "internal": name in internal,
            # mirrors billing_store.is_blocked: an explicit status, never a dip
            "blocked": bool(billable) and status in ("suspended", "closed"),
        })
    return jsonify({"accounts": out, "count": len(out)})


def _load_groups():
    """groups.json's ``{name: pod}`` map (empty when unreadable)."""
    import groups
    return groups.load_state().get("groups", {})


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
    return jsonify({"accounts": _merge_groups(billing_store.list_accounts())})


def _merge_groups(accounts):
    """Union of every platform group and every existing account row.

    Account rows are created lazily (first settle/topup/adjust/view), so a plain
    ``list_accounts`` hides groups that were never billed.  Admins expect the
    table to list *all* groups and to be able to flag any of them 内部 without
    having touched it first — so unknown groups get a synthesized default row
    (外部 / 计费开 / ¥0.00, ``synthetic=True``), and rows are annotated with the
    ``internal`` flag from groups.json.
    """
    try:
        state = _load_groups()
        names = set(state.keys())
        internal = {n for n, g in state.items() if g.get("internal")}
    except Exception:
        internal, names = set(), set()
    by_name = {a.get("group_name"): dict(a) for a in accounts}
    names |= set(by_name.keys())
    out = []
    for name in sorted(names):
        row = by_name.get(name)
        if row is None:
            row = {
                "group_name": name,
                "balance_cents": 0,
                "credit_limit_cents": 0,
                "status": "active",
                "billable": 1,
                "warn_ratio": 0.2,
                "updated_at": None,
                "synthetic": True,
            }
        row["internal"] = name in internal
        out.append(row)
    return out


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


# ── 按 tag 给 Pod 发额度（活动运营）─────────────────────────────
def _valid_batch(raw):
    s = str(raw or "").strip()
    if not s:
        return None
    return s if re.fullmatch(r"[A-Za-z0-9_-]{1,32}", s) else None


def _grant_token(batch, group):
    """每组一个独立 token —— transfer_token 是全局唯一键，同批不能共用。

    组名先散列，避免「组名前缀相同被截断」时同批 token 碰撞；同一 (batch, group)
    稳定不变，故同一 batch 重放天然幂等。
    """
    import hashlib
    h = hashlib.sha1((group or "").encode("utf-8")).hexdigest()[:12]
    return f"grant:{batch}:{h}"[:64]


@billing_bp.route("/admin/tags", methods=["GET"])
@require_auth("billing.account")
def admin_tags():
    """按标签聚合各组（活动方用它预览「某 tag 下有哪些 Pod、余额合计」）。"""
    if (bad := _money_ready()):
        return bad
    try:
        state = _load_groups()
    except Exception:
        return jsonify({"error": {"code": "ERROR", "message": "组状态不可用"}}), 500
    internal = {n for n, g in state.items() if g.get("internal")}
    rows = {r["group_name"]: r for r in billing_store.list_accounts()}
    buckets, untagged = {}, 0
    for name, g in state.items():
        tag = (g.get("tag") or "").strip()
        if not tag:
            untagged += 1
            continue
        acct = rows.get(name) or {}
        b = buckets.setdefault(tag, {"tag": tag, "count": 0, "balance_cents": 0,
                                     "internal": 0, "groups": []})
        b["count"] += 1
        b["balance_cents"] += int(acct.get("balance_cents") or 0)
        if name in internal:
            b["internal"] += 1
        b["groups"].append(name)
    tags = sorted(buckets.values(), key=lambda x: (-x["count"], x["tag"]))
    for b in tags:
        b["groups"].sort()
    return jsonify({"tags": tags, "untagged": untagged, "count": len(tags)})


@billing_bp.route("/admin/grant-by-tag", methods=["POST"])
@require_auth("billing.account")
def grant_by_tag():
    """按 tag 给一批 Pod 发放额度（活动发钱）。

    body: ``{tag, amount_cents, note?, batch?}``。只命中「tag 匹配、非平台内部组、
    且 billable 非 0」的组，逐组幂等发放（每组独立 token）。返回逐组结果与跳过原因；
    提供 ``batch`` 时同一 batch 重放不会重复加钱。
    """
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    tag = str(body.get("tag") or "").strip()
    if not tag:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 tag"}}), 400
    try:
        cents = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "amount_cents 必须为整数"}}), 400
    if cents <= 0:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "发放金额必须为正"}}), 400
    batch = _valid_batch(body.get("batch")) or _gen_transfer_token()
    actor = _caller_name()
    try:
        state = _load_groups()
    except Exception:
        return jsonify({"error": {"code": "ERROR", "message": "组状态不可用"}}), 500
    internal = {n for n, g in state.items() if g.get("internal")}
    rows = {r["group_name"]: r for r in billing_store.list_accounts()}
    note = body.get("note") or f"活动发放 tag={tag}"
    granted, skipped = [], []
    for name, g in sorted(state.items()):
        if (g.get("tag") or "").strip() != tag:
            continue
        if name in internal:
            skipped.append({"group": name, "reason": "内部组免计费"})
            continue
        acct = rows.get(name)
        if acct is not None and not int(acct.get("billable") or 0):
            skipped.append({"group": name, "reason": "已关闭计费"})
            continue
        try:
            bal = billing_store.grant(name, cents, _grant_token(batch, name),
                                      note=note, actor=actor)
        except Exception as exc:
            skipped.append({"group": name, "reason": str(exc)})
            continue
        granted.append({"group": name, "balance_cents": bal, "reused": bal is None})
    _audit("billing_grant_by_tag",
           f"tag={tag} amount={cents} batch={batch} "
           f"granted={len(granted)} skipped={len(skipped)}", actor)
    return jsonify({"ok": True, "tag": tag, "amount_cents": cents, "batch": batch,
                    "granted": granted, "skipped": skipped})


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


@billing_bp.route("/admin/accounts/<name>/restore", methods=["POST"])
@require_auth("billing.account")
def restore_account(name):
    """一键「恢复并启动」—— 停机的反操作。

    停机是两步(账户置 suspended + 工作负载缩到 0),所以恢复也必须两步,
    否则会出现「账户已 active 但 Pod 还停着」的半开状态。 这里把两步合成
    一次调用:置回 active,再 ``lifecycle.start_group`` 把 Pod 拉起来。

    body: ``{"start": bool}`` —— 传 ``false`` 只解冻账户、不启 Pod
    (例如先改价格/额度,稍后再手动启)。 返回 ``start_result`` 便于定位
    「账户恢复成功但 Pod 起不来」的原因(如节点无资源、组不存在)。
    """
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    try:
        acct = billing_store.set_account(name, status=billing_store.STATUS_ACTIVE)
    except ValueError as exc:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": str(exc)}}), 400
    started, start_result = False, None
    if body.get("start", True):
        try:
            import lifecycle
            start_result = lifecycle.start_group(name)
            started = bool((start_result or {}).get("ok"))
        except Exception as exc:
            start_result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    _audit("billing_account_restore", f"group={name} started={started}", actor)
    return jsonify({"ok": True, "account": acct, "started": started,
                    "start_result": start_result})


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


@billing_bp.route("/admin/health", methods=["GET"])
@require_auth("billing.account")
def billing_health():
    """计费运行自检 —— 让「为什么没扣费」一眼可见(只读)。

    Four checks in one request:

    * **prices** — how many unit prices are non-zero.  All-zero means billing is
      effectively off, however busy the settlement daemon looks.
    * **settle** — charges posted so far and the last settled period.  A zero
      count means the daemon has never posted anything.
    * **pay** — whether the payment gateway is configured and how many top-up
      orders exist (a configured gateway with zero orders = nobody has recharged).
    * **accounts** — groups in arrears / suspended, plus "zombie" rows: accounts
      whose group no longer exists in ``groups.json`` (they inflate the account
      table and used to generate meaningless low-balance alerts).
    """
    if (bad := _money_ready()):
        return bad
    try:
        state = _load_groups()
        known = set(state.keys())
        internal = {n for n, g in state.items() if g.get("internal")}
    except Exception:
        known, internal = set(), set()

    prices = billing_store.get_prices()
    nonzero = {k: float(v or 0) for k, v in prices.items() if float(v or 0) > 0}

    rows = billing_store.list_accounts()
    merged = _merge_groups(rows)
    zombies = sorted(r["group_name"] for r in rows
                     if known and r["group_name"] not in known)
    live = [r for r in rows if not known or r["group_name"] in known]
    billable = [r for r in live
                if int(r.get("billable") or 0) and r["group_name"] not in internal]
    external_off = sorted(
        r["group_name"] for r in merged
        if not r.get("internal") and not int(r.get("billable") or 0))
    try:
        policy = billing_store.get_policy()
    except Exception:
        policy = {"arrears_limit": False, "settle_from": None, "updated_by": ""}
    suspended = sorted(r["group_name"] for r in billable
                       if r.get("status") in ("suspended", "closed"))
    arrears = sorted(r["group_name"] for r in billable
                     if r.get("status") == "active" and int(r.get("balance_cents") or 0) <= 0)

    try:
        import pay
        pay_ok = bool(pay.configured())
        orders = pay.order_stats()["total"]
    except Exception:
        pay_ok, orders = False, {}

    ch = billing_store.charges_total()
    return jsonify({
        "prices": {"keys": len(prices), "set": len(nonzero), "nonzero": nonzero},
        "settle": {"last_period_end": ch["last_period_end"], "charges": ch["count"],
                   "charged_cents": ch["cents"]},
        "pay": {"configured": pay_ok, "orders": int(orders.get("orders") or 0),
                "paid": int(orders.get("paid") or 0),
                "credit_cents": int(orders.get("credit_cents") or 0)},
        "accounts": {"total": len(rows), "internal": len(internal),
                     "billable": len(billable), "suspended": suspended,
                     "arrears": arrears, "zombies": zombies,
                     "external_off": external_off},
        "policy": policy,
        # 欠费限制关掉时，扣费和停机都没在跑。
        "ok": bool(nonzero) and ch["count"] > 0 and bool(policy.get("arrears_limit")),
    })


@billing_bp.route("/admin/policy", methods=["GET"])
@require_auth("billing.account")
def billing_policy():
    """Whether arrears limits resources. Default is off."""
    if (bad := _money_ready()):
        return bad
    policy = billing_store.get_policy()
    import billing_settle
    policy["auto_suspend"] = billing_settle._auto_suspend_enabled()
    return jsonify(policy)


@billing_bp.route("/admin/policy", methods=["POST"])
@require_auth("billing.account")
def set_billing_policy():
    """Turn the arrears switch on or off.

    Enabling records the current hour as ``settle_from`` so earlier usage is
    not back-billed. Disabling stops charges, reminders, and stops.
    """
    if (bad := _money_ready()):
        return bad
    body = request.get_json(silent=True) or {}
    if "arrears_limit" not in body:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": "缺少 arrears_limit"}}), 400
    flag = bool(body.get("arrears_limit"))
    actor = (getattr(g, "api_user", None) or {}).get("username") or ""
    floor = (int(time.time()) // 3600 * 3600) if flag else None
    try:
        policy = billing_store.set_policy(flag, actor=actor, settle_from=floor)
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    _audit("billing_policy_set", f"arrears_limit={flag} settle_from={floor}", actor)
    import billing_settle
    policy["auto_suspend"] = billing_settle._auto_suspend_enabled()
    return jsonify({"ok": True, "policy": policy})


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
    外部(billable) groups.  Each entry carries the pod quota balance/status.
    内部组(internal)一概不列 —— 它们免计费，分配进去的钱不会被扣。"""
    import groups
    import users
    try:
        state = groups.load_state().get("groups", {})
        internal = groups.internal_groups()
    except Exception:
        return []
    out = []
    for name, pod in state.items():
        if name in internal:
            continue          # 内部组免计费 → 分配进去的钱不会被扣、只能管理员收回
        if _is_admin(user):
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
    try:
        if group in groups.internal_groups():
            return None, (jsonify({"error": {"code": "BAD_REQUEST",
                                             "message": "内部组免计费，无需分配额度"}}), 400)
    except Exception:
        pass
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
