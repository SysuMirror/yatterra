"""Profile API blueprint — /api/profile

User profile, password change, OAuth bind/unbind.
"""
from flask import Blueprint, request, jsonify, g, session
from middleware.error_handler import ApiError, bad_request, unauthorized

import users as users_mod
import oauth2_login
import audit

from api._auth import require_auth, current_username, current_user_obj

profile_bp = Blueprint("api_profile", __name__, url_prefix="/api/profile")


@profile_bp.route("", methods=["GET"])
@require_auth()
def profile_get():
    """Get the current user's profile."""
    _uo = current_user_obj()
    _cu = current_username()
    identities = users_mod.list_identities(_cu)
    bound_providers = {i["provider"] for i in identities}
    # OAuth session info for current login
    oauth_info = {}
    if session.get("oauth_provider"):
        oauth_info = {
            "oauth_provider": session["oauth_provider"],
            "oauth_name": session.get("oauth_name", ""),
            "oauth_email": session.get("oauth_email", ""),
        }
    return jsonify({
        "user": _uo,
        "identities": identities,
        "bound_providers": list(bound_providers),
        **oauth_info,
    })


@profile_bp.route("/password", methods=["POST"])
@require_auth()
def profile_password():
    """Change the current user's password.

    Body: {current_password, new_password}
    """
    body = request.get_json(silent=True) or {}
    current_pw = body.get("current_password", "")
    new_pw = body.get("new_password", "")

    if not new_pw:
        raise bad_request("New password is required")

    _cu = current_username()
    # Verify current password
    user = users_mod.authenticate(_cu, current_pw)
    if not user:
        raise bad_request("Current password is incorrect")

    ok, err = users_mod.set_password(_cu, new_pw)
    if not ok:
        raise bad_request(err)

    audit.record("api_password_change", detail=_cu, actor=_cu)
    return jsonify({"ok": True})


@profile_bp.route("/bind/ssemarket", methods=["POST"])
@require_auth()
def profile_bind_ssemarket():
    """Initiate SSE Market OAuth binding.

    Returns the OAuth redirect URL for the client to navigate to.
    """
    _cu = current_username()
    url = oauth2_login.ssemarket_authorize_redirect(
        "/oauth/callback/ssemarket", intent="bind", bind_username=_cu)
    return jsonify({"redirect_url": url})


@profile_bp.route("/bind/unisso", methods=["POST"])
@require_auth()
def profile_bind_unisso():
    """Initiate UniSSO OAuth binding.

    Returns the OAuth redirect URL for the client to navigate to.
    """
    _cu = current_username()
    url = oauth2_login.unisso_authorize_redirect(
        "/oauth/callback/unisso", intent="bind", bind_username=_cu)
    return jsonify({"redirect_url": url})


@profile_bp.route("/unbind", methods=["POST"])
@require_auth()
def profile_unbind():
    """Unbind an external OAuth identity.

    Body: {id}  — identity ID to unbind
    """
    body = request.get_json(silent=True) or {}
    identity_id = body.get("id")
    if not identity_id:
        raise bad_request("Identity id is required")

    _cu = current_username()
    ok = users_mod.unbind_identity(_cu, identity_id)
    if ok:
        audit.record("api_oauth_unbind", detail=f"id={identity_id} user={_cu}", actor=_cu)
    return jsonify({"ok": ok})
