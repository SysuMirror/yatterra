"""Payment API blueprint — /api/billing/pay (学人汇「通用开放支付」充值)。

预付费余额的资金入口:用户为**组**下单充值,微信小程序内付款,学人汇签名回调
``POST /notify`` → ``pay.settle_paid`` 给组账户入账(见 ``billing_store``)。

鉴权分层:

* 用户端(``/items`` ``/create`` ``/order`` ``/orders`` ``/account``)——需要登录,
  下单必须是自己**所属组**的成员(``users.can_pod`` level=member);查单只限本组。
* ``POST /notify`` —— **无鉴权/无 CSRF**(``/api/`` 已在 ``app.csrf_protect`` 豁免),
  安全性来自 HMAC 验签(``pay_sign``):校验 ``X-App-Id``、``|now-ts| <= 300``、
  原始 body 字节签名。
* 管理端(``/admin/*``)——``billing.price``(商品/对账)或 ``billing.account``(订单/统计)。
"""
import time

from flask import Blueprint, request, jsonify, g

from api._auth import require_auth
import pay as pay_mod
import pay_sign

try:
    import billing_store
except Exception:  # pragma: no cover
    billing_store = None

pay_bp = Blueprint("api_pay", __name__, url_prefix="/api/billing/pay")

_MAX_TS_SKEW = 300  # seconds the callback timestamp may drift


def _actor():
    return (getattr(g, "api_user", None) or {}).get("username") or ""


def _username():
    return (getattr(g, "api_user", None) or {}).get("username") or None


def _member_of(user, group):
    """True when ``user`` is a member/owner of ``group`` (best effort)."""
    import groups as groups_mod
    from importlib import import_module
    users = import_module("users")
    try:
        pod = groups_mod.load_state()["groups"].get(group)
        if not pod:
            return False
        return users.can_pod(user, pod, "member")
    except Exception:
        return False


def _gen_trade_no():
    """Order id: 'YT' + base36(ms) + 6 hex chars — unique enough, unguessable-ish."""
    n = int(time.time() * 1000)
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    b36 = ""
    while n:
        n, r = divmod(n, 36)
        b36 = digits[r] + b36
    return "YT" + (b36 or "0") + __import__("os").urandom(3).hex().upper()


def _money_ready():
    if billing_store is None:
        return jsonify({"error": {"code": "UNAVAILABLE", "message": "计费资金层不可用"}}), 503
    return None


# ── user-facing ──────────────────────────────────────────────────
@pay_bp.route("/items", methods=["GET"])
@require_auth(min_role="user")
def items():
    """Active top-up SKUs."""
    try:
        rows = pay_mod.list_items(active_only=request.args.get("all") != "1")
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": str(exc)}}), 500
    return jsonify({"items": rows, "configured": pay_mod.configured()})


@pay_bp.route("/create", methods=["POST"])
@require_auth("billing.pay")
def create():
    """Create a top-up order for a group: ``{item_key, group, out_trade_no?}``."""
    body = request.get_json(silent=True) or {}
    item_key = str(body.get("item_key") or "").strip()
    group = str(body.get("group") or body.get("group_name") or "").strip()
    if not item_key:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 item_key"}}), 400
    if not group:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 group"}}), 400
    user = getattr(g, "api_user", None)
    if not _member_of(user, group):
        return jsonify({"error": {"code": "FORBIDDEN", "message": f"不是组 {group} 的成员"}}), 403

    item = pay_mod.get_item(item_key)
    if not item or not int(item.get("is_active") or 0):
        return jsonify({"error": {"code": "NOT_FOUND", "message": "商品不存在或已下架"}}), 404

    reuse = str(body.get("out_trade_no") or "").strip()
    if reuse:
        if not (6 <= len(reuse) <= 64) or not all(c.isalnum() or c in "_-" for c in reuse):
            return jsonify({"error": {"code": "BAD_REQUEST", "message": "out_trade_no 非法"}}), 400
        existing = pay_mod.get_order(reuse)
        if existing:
            if existing.get("group_name") != group:
                return jsonify({"error": {"code": "CONFLICT", "message": "订单号已被占用"}}), 409
            return jsonify({"ok": True, "reused": True, "order": existing,
                            "short_url": "", "scheme_url": ""})
        out_trade_no = reuse
    else:
        out_trade_no = _gen_trade_no()

    amount = int(item["amount_cents"])
    credit = int(item.get("credit_cents") or amount)
    cfg = pay_mod.config()
    try:
        r = pay_mod.create_order(
            amount_cents=amount, subject=item["title"], out_trade_no=out_trade_no,
            return_url=(body.get("return_url") or cfg.get("return_url") or None),
            extra={"item_key": item_key, "group": group, "username": _username()},
        )
    except pay_mod.PayError as exc:
        return jsonify({"error": {"code": "UPSTREAM", "message": str(exc)}}), int(exc.status or 500)

    r = r or {}
    try:
        pay_mod.record_order(
            out_trade_no=out_trade_no, fs_order_no=r.get("order_no"),
            item_key=item_key, subject=item["title"], amount_cents=amount,
            credit_cents=credit, group_name=group, username=_username(), status="pending")
    except Exception as exc:
        return jsonify({"error": {"code": "ERROR", "message": f"订单入库失败: {exc}"}}), 500

    _audit("pay_order_create", f"group={group} item={item_key} no={out_trade_no} amount={amount}")
    return jsonify({
        "ok": True, "out_trade_no": out_trade_no, "amount_cents": amount,
        "credit_cents": credit, "currency": "CNY", "subject": item["title"],
        "short_url": r.get("short_url") or "", "scheme_url": r.get("scheme_url") or "",
    })


@pay_bp.route("/order/<out_trade_no>", methods=["GET"])
@require_auth(min_role="user")
def order(out_trade_no):
    """Query one order; if still pending, ask the gateway and settle on paid."""
    o = pay_mod.get_order(out_trade_no)
    if not o:
        return jsonify({"error": {"code": "NOT_FOUND", "message": "订单不存在"}}), 404
    if not _member_of(getattr(g, "api_user", None), o.get("group_name")):
        return jsonify({"error": {"code": "FORBIDDEN", "message": "无权查看该订单"}}), 403
    if o.get("status") != "paid":
        try:
            r = pay_mod.query_order(out_trade_no)
            if r and r.get("paid"):
                pay_mod.settle_paid(out_trade_no, r.get("transaction_id"),
                                    {"source": "status_poll", "amount_cents": r.get("amount_cents")})
                o = pay_mod.get_order(out_trade_no)
        except Exception:
            pass  # 回源失败不阻断查询
    return jsonify({"order": o})


@pay_bp.route("/orders", methods=["GET"])
@require_auth(min_role="user")
def orders():
    """Orders for the caller's groups (``?group=`` narrows to one)."""
    group = request.args.get("group")
    if group and not _member_of(getattr(g, "api_user", None), group):
        return jsonify({"error": {"code": "FORBIDDEN", "message": "无权查看该组订单"}}), 403
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except (TypeError, ValueError):
        limit = 50
    return jsonify({"orders": pay_mod.list_orders(group_name=group or None, limit=limit)})


@pay_bp.route("/account/<group>", methods=["GET"])
@require_auth(min_role="user")
def account(group):
    """Balance + recent ledger for one group (members may read their own)."""
    if (bad := _money_ready()):
        return bad
    if not _member_of(getattr(g, "api_user", None), group):
        return jsonify({"error": {"code": "FORBIDDEN", "message": "无权查看该组账户"}}), 403
    billing_store.ensure_account(group)
    acct = billing_store.get_account(group)
    return jsonify({
        "group": group,
        "account": acct,
        "balance_ratio": billing_store.balance_ratio(acct),
        "blocked": billing_store.is_blocked(group),
        "ledger": billing_store.ledger(group, limit=int(request.args.get("limit", 50))),
    })


# ── notify (学人汇 → 本应用, HMAC 验签) ─────────────────────────
@pay_bp.route("/notify", methods=["POST"])
def notify():
    """Payment callback.  Verified by HMAC over the **raw** body bytes."""
    cfg = pay_mod.config()
    raw = request.get_data(cache=True, as_text=False)
    ts = request.headers.get("X-Timestamp")
    nonce = request.headers.get("X-Nonce")
    sig = request.headers.get("X-Signature")
    app_id = request.headers.get("X-App-Id")
    if not ts or not nonce or not sig or app_id != cfg["app_id"]:
        _audit("pay_notify_reject", "missing headers / app_id mismatch")
        return jsonify({"ok": False, "msg": "验签失败"}), 401
    try:
        skew = abs(int(time.time()) - int(ts))
    except (TypeError, ValueError):
        _audit("pay_notify_reject", f"bad ts={ts}")
        return jsonify({"ok": False, "msg": "验签失败"}), 401
    if skew > _MAX_TS_SKEW:
        _audit("pay_notify_reject", f"expired ts={ts}")
        return jsonify({"ok": False, "msg": "回调已过期"}), 401
    if not pay_sign.verify(cfg["app_secret"], "POST", pay_mod.notify_path(), ts, nonce, raw, sig):
        _audit("pay_notify_reject", "bad signature")
        return jsonify({"ok": False, "msg": "验签失败"}), 401

    import json as _json
    try:
        data = _json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return jsonify({"ok": False, "msg": "载荷非法"}), 400
    if not isinstance(data, dict):
        return jsonify({"ok": False, "msg": "载荷非法"}), 400
    if data.get("event") != "payment.succeeded":
        return jsonify({"ok": True, "msg": "ignored"})

    try:
        credited = pay_mod.settle_paid(data.get("out_trade_no"),
                                       data.get("transaction_id"), data)
    except Exception as exc:
        _audit("pay_notify_reject", f"settle failed: {exc}")
        return jsonify({"ok": False, "msg": "回调处理失败"}), 500
    _audit("pay_notify", f"no={data.get('out_trade_no')} credited={credited}")
    return jsonify({"ok": True, "msg": "ok", "credited_cents": credited})


# ── admin ────────────────────────────────────────────────────────
@pay_bp.route("/admin/items", methods=["GET"])
@require_auth("billing.price")
def admin_items():
    return jsonify({"items": pay_mod.list_items(active_only=False)})


@pay_bp.route("/admin/items", methods=["POST"])
@require_auth("billing.price")
def admin_upsert_item():
    body = request.get_json(silent=True) or {}
    key = str(body.get("item_key") or "").strip()
    title = str(body.get("title") or "").strip()
    if not key or not all(c.isalnum() or c in "_.-" for c in key) or len(key) > 64:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "item_key 非法"}}), 400
    if not title or len(title) > 128:
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "标题非法"}}), 400
    try:
        amount = int(body.get("amount_cents"))
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "金额必须为整数分"}}), 400
    if not (1 <= amount <= 5_000_000):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "金额需为 1 ~ 5,000,000 分"}}), 400
    credit = body.get("credit_cents")
    credit = int(credit) if credit not in (None, "") else amount
    desc = (str(body.get("description"))[:255] if body.get("description") else None)
    pay_mod.upsert_item(key, title, amount, credit_cents=credit, description=desc,
                        sort_order=int(body.get("sort_order") or 0),
                        is_active=0 if body.get("is_active") in (False, 0, "0") else 1)
    _audit("pay_item_set", f"key={key} amount={amount} credit={credit}")
    return jsonify({"ok": True, "items": pay_mod.list_items(active_only=False)})


@pay_bp.route("/admin/items/<key>/delete", methods=["POST"])
@require_auth("billing.price")
def admin_del_item(key):
    pay_mod.set_item_active(key, False)
    _audit("pay_item_set", f"key={key} deactivated")
    return jsonify({"ok": True, "msg": f"已下架: {key}"})


@pay_bp.route("/admin/orders", methods=["GET"])
@require_auth("billing.account")
def admin_orders():
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except (TypeError, ValueError):
        limit = 50
    return jsonify({"orders": pay_mod.list_orders(group_name=request.args.get("group"),
                                                  limit=limit)})


@pay_bp.route("/admin/stats", methods=["GET"])
@require_auth("billing.account")
def admin_stats():
    return jsonify(pay_mod.order_stats())


@pay_bp.route("/admin/reconcile", methods=["GET"])
@require_auth("billing.price")
def admin_reconcile():
    """Cross-check pending orders against the gateway (``?limit=`` scanned)."""
    try:
        limit = max(1, min(200, int(request.args.get("limit", 100))))
    except (TypeError, ValueError):
        limit = 100
    pending = [o for o in pay_mod.list_orders(limit=limit) if o.get("status") != "paid"]
    settled, checked, errors = [], 0, 0
    for o in pending:
        no = o["out_trade_no"]
        try:
            r = pay_mod.query_order(no)
            checked += 1
            if r and r.get("paid"):
                credited = pay_mod.settle_paid(no, r.get("transaction_id"),
                                               {"source": "reconcile", "amount_cents": r.get("amount_cents")})
                settled.append({"out_trade_no": no, "credited_cents": credited})
        except Exception:
            errors += 1
    _audit("pay_reconcile", f"checked={checked} settled={len(settled)} errors={errors}")
    return jsonify({"pending": len(pending), "checked": checked,
                    "settled": settled, "errors": errors})


def _audit(action, detail):
    try:
        import audit
        audit.record(action, detail=detail, actor=_actor() or "pay")
    except Exception:
        pass
