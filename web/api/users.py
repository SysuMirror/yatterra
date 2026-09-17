"""Users API blueprint — /api/users

User CRUD for admin management.
"""
from flask import Blueprint, request, jsonify, g, session
from middleware.error_handler import ApiError, bad_request, not_found, forbidden

import users as users_mod
import audit

from api._auth import require_auth, current_username, current_user_obj

users_bp = Blueprint("api_users", __name__, url_prefix="/api/users")

# --- Tokens blueprint at /api/tokens (SPA compatibility) ---
tokens_bp = Blueprint("api_tokens", __name__, url_prefix="/api/tokens")


@tokens_bp.route("", methods=["GET"])
@require_auth()
def tokens_list():
    """List API tokens for the current user."""
    return jsonify({"tokens": users_mod.list_tokens(current_username())})


@tokens_bp.route("", methods=["POST"])
@require_auth()
def tokens_create():
    """Create a new API token for the current user."""
    body = request.get_json(silent=True) or {}
    token = users_mod.create_token(current_username(), body.get("name", ""))
    return jsonify({"token": token}), 201


@tokens_bp.route("/<tid>", methods=["DELETE"])
@require_auth()
def tokens_delete(tid):
    """Delete an API token."""
    if not users_mod.delete_token(current_username(), tid):
        return jsonify({"error": "token 不存在或不属于你"}), 404
    return jsonify({"ok": True})


@users_bp.route("", methods=["GET"])
@require_auth("admin.users")
def users_list():
    """List all users."""
    return jsonify({
        "users": users_mod.list_users(),
        "current": current_username(),
    })


@users_bp.route("", methods=["POST"])
@require_auth("admin.users")
def users_create():
    """Create a new user.

    Body: {username, password, role}
    """
    body = request.get_json(silent=True) or {}
    _uo = current_user_obj()

    # Admin cannot create super users
    if _uo.get("role") != "super" and body.get("role") == "super":
        raise forbidden("Only super admins can create super admin users")

    username = body.get("username", "")
    password = body.get("password", "")
    role = body.get("role", "user")

    ok, err = users_mod.create_user(username, password, role)
    if not ok:
        raise bad_request(err)

    audit.record("api_user_add", detail=f"{username} role={role}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True}), 201


@users_bp.route("/<username>", methods=["PUT"])
@require_auth("admin.users")
def users_update(username):
    """Update a user (role and/or password).

    Body: {role?, password?}
    """
    body = request.get_json(silent=True) or {}
    _uo = current_user_obj()
    target = users_mod.get_user(username)

    if not target:
        raise not_found(f"User {username} not found")

    # Role update
    if "role" in body:
        role = body["role"]
        if role == "super" and _uo.get("role") != "super":
            raise forbidden("Only super admins can grant super admin role")
        if target.get("role") == "super" and _uo.get("role") != "super":
            raise forbidden("Only super admins can modify super admin users")
        users_mod.set_role(username, role)
        audit.record("api_user_role", detail=f"{username} -> {role}",
                     actor=current_username() or "unknown")

    # Password update
    if "password" in body:
        pw = body["password"]
        if target.get("role") == "super" and _uo.get("role") != "super":
            raise forbidden("Only super admins can change super admin passwords")
        ok, err = users_mod.set_password(username, pw)
        if not ok:
            raise bad_request(err)
        audit.record("api_user_password", detail=username,
                     actor=current_username() or "unknown")

    return jsonify({"ok": True})


@users_bp.route("/<username>", methods=["DELETE"])
@require_auth("admin.users")
def users_delete(username):
    """Delete a user."""
    _uo = current_user_obj()

    if username == current_username():
        raise bad_request("Cannot delete yourself")

    target = users_mod.get_user(username)
    if not target:
        raise not_found(f"User {username} not found")

    if target.get("role") == "super" and _uo.get("role") != "super":
        raise forbidden("Only super admins can delete super admin users")

    users_mod.delete_user(username)
    audit.record("api_user_delete", detail=username,
                 actor=current_username() or "unknown")
    return jsonify({"ok": True})
