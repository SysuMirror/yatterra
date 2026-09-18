"""Push notification API — /api/push

Web Push Protocol (VAPID) for notifying PWA users of new versions.

Endpoints:
  GET  /api/push/vapid-key   → VAPID public key (for client subscription)
  POST /api/push/subscribe    → Save a push subscription
  POST /api/push/unsubscribe  → Remove a push subscription
  POST /api/push/notify-all   → Send push to all subscribers (admin only)
"""
import json, os, logging, threading
from flask import Blueprint, request, jsonify, g
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
        "ttl": 3600,
    }


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
    for sub in subs:
        try:
            webpush(subscription_info={"endpoint": sub["endpoint"],
                                       "keys": sub.get("keys", {})},
                    data=encoded, **vapid)
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


def send_to_users(usernames, payload):
    """Send a notification only to subscriptions owned by these users."""
    wanted = {str(u) for u in (usernames or []) if u}
    if not wanted:
        return {"sent": 0, "total": 0, "errors": 0, "stale_removed": 0}
    subs = [s for s in _load_subs() if s.get("_user") in wanted]
    return _send_subscriptions(subs, payload)


@push_bp.route("/status", methods=["GET"])
@require_auth("admin.users")
def push_status():
    """Return push subscription stats (admin only)."""
    subs = _load_subs()
    return jsonify({"total_subscribers": len(subs)})
