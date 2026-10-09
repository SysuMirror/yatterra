"""Push notification API — /api/push

Web Push Protocol (VAPID) for notifying PWA users of new versions.

Endpoints:
  GET  /api/push/vapid-key   → VAPID public key (for client subscription)
  POST /api/push/subscribe    → Save a push subscription
  POST /api/push/unsubscribe  → Remove a push subscription
  POST /api/push/notify-all   → Send push to all subscribers (admin only)
"""
import json, os, logging, threading
from flask import Blueprint, request, jsonify
from pywebpush import webpush, WebPushException
from api._auth import require_auth, current_username

logger = logging.getLogger(__name__)

push_bp = Blueprint("api_push", __name__, url_prefix="/api/push")

# ── VAPID keys ────────────────────────────────────────────────
import siteconf

VAPID_FILE = siteconf.web_path("vapid.json")
SUBS_FILE = siteconf.web_path("push_subscriptions.json")
_SUBS_LOCK = threading.RLock()


def _load_vapid():
    with open(VAPID_FILE) as f:
        return json.load(f)


def _vapid_info():
    keys = _load_vapid()
    # pywebpush accepts only the private key and claims; the public key is
    # carried by the subscription and passing it is not a valid kwarg.
    return {
        "vapid_private_key": keys["private_key_pem"],
        "vapid_claims": {"sub": keys["subject"]},
    }


# ttl 按 urgency 分级: high 存一天, normal 一小时, low 十分钟
_TTL_BY_URGENCY = {"high": 86400, "normal": 3600, "low": 600}


def _load_subs():
    with _SUBS_LOCK:
        try:
            with open(SUBS_FILE) as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []


def _save_subs(subs):
    with _SUBS_LOCK:
        tmp = SUBS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(subs, f, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, SUBS_FILE)


# ── Endpoints ─────────────────────────────────────────────────

@push_bp.route("/vapid-key", methods=["GET"])
def vapid_key():
    """Return VAPID public key for client-side push subscription."""
    keys = _load_vapid()
    return jsonify({"publicKey": keys["public_key_b64"]})


@push_bp.route("/subscribe", methods=["POST"])
@require_auth()
def subscribe():
    """Save a push subscription for the current user."""
    user = current_username()
    sub = request.get_json(silent=True)
    if not sub or not sub.get("endpoint"):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "Missing subscription data"}}), 400

    with _SUBS_LOCK:
        subs = _load_subs()
        subs = [s for s in subs if s.get("endpoint") != sub["endpoint"]]
        sub["_user"] = user
        subs.append(sub)
        _save_subs(subs)

    logger.info("Push subscription saved for %s (total: %d)", user, len(subs))
    return jsonify({"ok": True})


@push_bp.route("/unsubscribe", methods=["POST"])
@require_auth()
def unsubscribe():
    """Remove a push subscription."""
    user = current_username()
    data = request.get_json(silent=True) or {}
    endpoint = data.get("endpoint")

    with _SUBS_LOCK:
        subs = _load_subs()
        if endpoint:
            subs = [s for s in subs if s.get("endpoint") != endpoint]
        else:
            subs = [s for s in subs if s.get("_user") != user]
        _save_subs(subs)

    logger.info("Push subscription removed for %s (remaining: %d)", user, len(subs))
    return jsonify({"ok": True})


@push_bp.route("/notify-all", methods=["POST"])
@require_auth("admin.users")
def notify_all():
    """Send a push notification to all subscribers. Requires admin permission."""
    data = request.get_json(silent=True) or {}
    title = data.get("title", "sseinfra 更新")
    body = data.get("body", "新版本已部署，点击刷新获取最新功能")
    url = data.get("url", "/")

    subs = _load_subs()
    if not subs:
        return jsonify({"sent": 0, "total": 0, "errors": 0})

    payload = {"title": title, "body": body, "url": url}
    result = _send_subscriptions(subs, payload)
    return jsonify({"sent": result["sent"], "total": result["total"],
                    "errors": result["errors"], "stale_removed": result["stale_removed"]})


def _send_subscriptions(subs, payload):
    """Send one payload to subscriptions and prune expired endpoints."""
    try:
        vapid = _vapid_info()
    except Exception:
        logger.exception("Push VAPID configuration unavailable")
        return {"sent": 0, "total": len(subs), "errors": len(subs), "stale_removed": 0}
    sent = errors = 0
    stale = []
    encoded = json.dumps(payload, ensure_ascii=False)
    urgency = payload.get("urgency") if isinstance(payload, dict) else None
    if urgency not in _TTL_BY_URGENCY:
        urgency = "normal"
    topic = payload.get("topic") if isinstance(payload, dict) else None
    # pywebpush 不接受 urgency 关键字, Urgency 走 HTTP headers
    headers = {"Urgency": urgency}
    if topic:
        headers["Topic"] = str(topic)
    for sub in subs:
        try:
            kwargs = dict(vapid)
            kwargs["ttl"] = _TTL_BY_URGENCY[urgency]
            kwargs["headers"] = dict(headers)
            webpush(subscription_info={"endpoint": sub["endpoint"],
                                       "keys": sub.get("keys", {})},
                    data=encoded, **kwargs)
            sent += 1
        except WebPushException as exc:
            logger.warning("Push failed for user %s: %s", sub.get("_user", "?"), exc)
            errors += 1
            if "410" in str(exc) or "404" in str(exc) or "not found" in str(exc).lower():
                stale.append(sub)
        except Exception:
            logger.exception("Push error for user %s", sub.get("_user", "?"))
            errors += 1
    if stale:
        with _SUBS_LOCK:
            current = _load_subs()
            stale_endpoints = {s.get("endpoint") for s in stale}
            _save_subs([s for s in current if s.get("endpoint") not in stale_endpoints])
    return {"sent": sent, "total": len(subs), "errors": errors, "stale_removed": len(stale)}


def send_to_users(usernames, payload, kind=None):
    """Send a notification only to subscriptions owned by these users.

    kind 未显式给出时取 payload 的 type/kind 字段; 用户 prefs.push_kinds
    非空则只发 kind 在列表内的订阅, None 表示全部接收。
    """
    wanted = {str(u) for u in (usernames or []) if u}
    if not wanted:
        return {"sent": 0, "total": 0, "errors": 0, "stale_removed": 0}
    if kind is None and isinstance(payload, dict):
        kind = payload.get("type") or payload.get("kind")
    subs = [s for s in _load_subs() if s.get("_user") in wanted]
    if kind:
        prefs_cache = {}
        import users as users_mod
        allowed = []
        for s in subs:
            u = s.get("_user")
            if u not in prefs_cache:
                try:
                    prefs_cache[u] = users_mod.get_push_kinds(u)
                except Exception:
                    logger.exception("读取用户 %s 推送偏好失败, 按全部处理", u)
                    prefs_cache[u] = None
            kinds = prefs_cache[u]
            if kinds is None or kind in kinds:
                allowed.append(s)
        skipped = len(subs) - len(allowed)
        if skipped:
            logger.info("推送按偏好跳过 %d 条订阅 (kind=%s)", skipped, kind)
        subs = allowed
    return _send_subscriptions(subs, payload)


@push_bp.route("/events", methods=["GET"])
@require_auth()
def events():
    """通知中心:读取最近告警事件(去重表),支持分页与未读过滤。"""
    try:
        unread_only = request.args.get("unread_only") in ("1", "true", "yes")
        limit = int(request.args.get("limit", 20) or 20)
        offset = int(request.args.get("offset", 0) or 0)
    except (TypeError, ValueError):
        return jsonify({"error": {"code": "BAD_REQUEST", "message": "参数错误"}}), 400
    kind = request.args.get("kind") or None
    import pwa_alerts
    items, total, unread = pwa_alerts.list_events(
        current_username(), limit=limit, offset=offset,
        unread_only=unread_only, kind=kind)
    return jsonify({"events": items, "total": total, "unread": unread,
                    "limit": limit, "offset": offset})


@push_bp.route("/events/read", methods=["POST"])
@require_auth()
def events_read():
    """通知中心:标记已读。body 传 {"keys": [event_key...]} 或 {"all": true}。"""
    data = request.get_json(silent=True) or {}
    import pwa_alerts
    if data.get("all"):
        n = pwa_alerts.mark_read(current_username(), all=True)
    elif isinstance(data.get("keys"), list):
        n = pwa_alerts.mark_read(current_username(), event_keys=data["keys"])
    else:
        return jsonify({"error": {"code": "BAD_REQUEST",
                                  "message": "需要 keys 列表或 all=true"}}), 400
    return jsonify({"ok": True, "updated": n})


@push_bp.route("/status", methods=["GET"])
@require_auth("admin.users")
def push_status():
    """Return push subscription stats (admin only)."""
    subs = _load_subs()
    return jsonify({"total_subscribers": len(subs)})
