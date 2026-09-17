"""Push notification API — /api/push

Web Push Protocol (VAPID) for notifying PWA users of new versions.

Endpoints:
  GET  /api/push/vapid-key   → VAPID public key (for client subscription)
  POST /api/push/subscribe    → Save a push subscription
  POST /api/push/unsubscribe  → Remove a push subscription
  POST /api/push/notify-all   → Send push to all subscribers (admin only)
"""
import json, os, logging
from flask import Blueprint, request, jsonify, g
from pywebpush import webpush, WebPushException
from api._auth import require_auth, current_username

logger = logging.getLogger(__name__)

push_bp = Blueprint("api_push", __name__, url_prefix="/api/push")

# ── VAPID keys ────────────────────────────────────────────────
import siteconf

VAPID_FILE = siteconf.web_path("vapid.json")
SUBS_FILE = siteconf.web_path("push_subscriptions.json")


def _load_vapid():
    with open(VAPID_FILE) as f:
        return json.load(f)


def _vapid_info():
    keys = _load_vapid()
    return {
        "vapid_private_key": keys["private_key_pem"],
        "vapid_public_key": keys["public_key_pem"],
        "vapid_claims": {"sub": keys["subject"]},
    }


def _load_subs():
    try:
        with open(SUBS_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return []


def _save_subs(subs):
    with open(SUBS_FILE, "w") as f:
        json.dump(subs, f, indent=2)


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

    subs = _load_subs()
    # Remove existing subscription for this endpoint (dedup)
    subs = [s for s in subs if s.get("endpoint") != sub["endpoint"]]
    # Add with username
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

    payload = json.dumps({"title": title, "body": body, "url": url})
    vapid = _vapid_info()

    sent = 0
    errors = 0
    stale = []

    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": sub.get("keys", {}),
                },
                data=payload,
                **vapid,
            )
            sent += 1
        except WebPushException as e:
            logger.warning("Push failed for %s: %s", sub.get("_user", "?"), e)
            errors += 1
            # If the subscription is expired/invalid, mark for removal
            if "410" in str(e) or "not found" in str(e).lower():
                stale.append(sub)
        except Exception as e:
            logger.error("Push error for %s: %s", sub.get("_user", "?"), e)
            errors += 1

    # Remove stale subscriptions
    if stale:
        subs = [s for s in subs if s not in stale]
        _save_subs(subs)
        logger.info("Removed %d stale subscriptions", len(stale))

    return jsonify({"sent": sent, "total": len(subs) + len(stale), "errors": errors, "stale_removed": len(stale)})


@push_bp.route("/status", methods=["GET"])
@require_auth("admin.users")
def push_status():
    """Return push subscription stats (admin only)."""
    subs = _load_subs()
    return jsonify({"total_subscribers": len(subs)})
