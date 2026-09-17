#!/usr/bin/env python3
"""Authentication API Blueprint — session-based login/logout/guest/OAuth.

Mounted at /api/auth.  All endpoints return JSON (except OAuth redirects
which are browser flows that end with a 302 back to the frontend).

Imports:
  oauth2_login  — OAuth2 authorize/exchange/userinfo helpers
  users         — user store, authenticate, identity binding
  audit         — audit log recording
  middleware.error_handler.ApiError — structured JSON errors
  middleware.csrf  — CSRF token generation/validation
"""
import secrets
import time
import logging

from flask import Blueprint, request, session, jsonify, redirect

import oauth2_login
import users
import audit
from middleware.error_handler import ApiError, unauthorized, bad_request, forbidden
from middleware.csrf import generate_csrf_token, require_csrf

log = logging.getLogger("auth_api")

auth_bp = Blueprint("auth_api", __name__, url_prefix="/api/auth")

# ---------------------------------------------------------------------------
# Login rate limiting (in-memory, per-IP) — shared state for this worker
# ---------------------------------------------------------------------------
_LOGIN_FAILS: dict[str, dict] = {}   # ip -> {"fails": int, "locked_until": float}
LOGIN_MAX_FAILS = 5
LOGIN_LOCK_SECS = 300

# Session user cache TTL (seconds) — must match app.py's _USER_CACHE_TTL
_USER_CACHE_TTL = 30


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _session_user_obj():
    """Return user dict from session cache; refresh from DB if stale.

    Mirrors the same logic in app.py so the blueprint is self-contained.
    """
    if not session.get("logged_in"):
        return None
    _uo = session.get("_user_obj")
    _ts = session.get("_user_ts", 0)
    if _uo and (time.time() - _ts) < _USER_CACHE_TTL:
        return _uo
    # cache miss or stale — hit DB
    _fresh = users.get_user(session.get("user"))
    if _fresh:
        session["_user_obj"] = _fresh
        session["_user_ts"] = time.time()
    return _fresh


def _user_perms_list():
    """Return sorted list of expanded permissions for the current session user."""
    u = _session_user_obj()
    return sorted(users.expanded_perms(u))


def _set_login_session(username: str, user: dict, *, permanent: bool = True):
    """Populate session with login state."""
    session.clear()
    session["logged_in"] = True
    session["user"] = username
    session["role"] = user.get("role", "user")
    session["_user_obj"] = user
    session["_user_ts"] = time.time()
    session.permanent = permanent


def _me_response():
    """Build the standard current-user info dict."""
    logged_in = bool(session.get("logged_in"))
    if not logged_in:
        return {"user": None, "perms": [], "role": None, "is_logged_in": False}
    return {
        "user": session.get("user"),
        "perms": _user_perms_list(),
        "role": session.get("role"),
        "is_logged_in": True,
    }


# ---------------------------------------------------------------------------
# POST /api/auth/login  — username/password JSON login
# ---------------------------------------------------------------------------

@auth_bp.route("/login", methods=["POST"])
def login():
    """Authenticate with username + password.

    Request JSON:  {"username": "...", "password": "..."}
    Success 200:   {"user": "<username>", "perms": [...], "role": "<role>"}
    Failure 401:   {"error": {"code": "...", "message": "..."}}
    """
    data = request.get_json(silent=True) or {}
    username = (data.get("username", "") or "").strip()
    pw = data.get("password", "")

    if not username or not pw:
        raise bad_request("用户名和密码不能为空")

    # --- rate limiting ---
    ip = request.remote_addr or "unknown"
    rec = _LOGIN_FAILS.get(ip, {"fails": 0, "locked_until": 0})
    now = time.time()
    if rec.get("locked_until", 0) > now:
        raise forbidden("登录尝试过多,请5分钟后再试")

    # --- authenticate ---
    user = users.authenticate(username, pw)
    if not user:
        audit.record("login_fail", detail=f"{username} ip={ip}")
        rec["fails"] = rec.get("fails", 0) + 1
        if rec["fails"] >= LOGIN_MAX_FAILS:
            rec["locked_until"] = now + LOGIN_LOCK_SECS
            rec["fails"] = 0
        _LOGIN_FAILS[ip] = rec
        raise unauthorized("用户名或密码错误")

    # --- success ---
    _set_login_session(username, user)
    _LOGIN_FAILS.pop(ip, None)
    audit.record("login", detail=f"{username} ip={ip}")

    # Ensure CSRF token is generated for the new session
    generate_csrf_token()

    return jsonify(_me_response()), 200


# ---------------------------------------------------------------------------
# POST /api/auth/logout  — clear session
# ---------------------------------------------------------------------------

@auth_bp.route("/logout", methods=["POST"])
def logout():
    """Clear the session and return 204 No Content."""
    username = session.get("user")
    if username:
        audit.record("logout", detail=f"{username}", actor=username)
    session.clear()
    return "", 204


# ---------------------------------------------------------------------------
# POST /api/auth/guest  — guest login (no credentials)
# ---------------------------------------------------------------------------

@auth_bp.route("/guest", methods=["POST"])
def guest():
    """Create a guest session without username/password.

    Success 200: {"user": "guest", "perms": [...], "role": "guest"}
    """
    ip = request.remote_addr or "unknown"
    guest_user = {"username": "guest", "role": "guest"}
    _set_login_session("guest", guest_user)
    audit.record("login_guest", detail=f"ip={ip}")

    generate_csrf_token()

    return jsonify(_me_response()), 200


# ---------------------------------------------------------------------------
# GET /api/auth/me  — current user info
# ---------------------------------------------------------------------------

@auth_bp.route("/me", methods=["GET"])
def me():
    """Return current session user info.

    Response 200: {"user": "<username>"|null, "perms": [...], "role": "<role>"|null, "is_logged_in": bool}
    """
    return jsonify(_me_response()), 200


# ---------------------------------------------------------------------------
# GET /api/auth/csrf  — return CSRF token for the current session
# ---------------------------------------------------------------------------

@auth_bp.route("/csrf", methods=["GET"])
def csrf():
    """Return CSRF token for the current session.

    Response 200: {"token": "<csrf_token>"}
    """
    token = generate_csrf_token()
    return jsonify({"token": token}), 200


# ---------------------------------------------------------------------------
# GET /api/auth/oauth/ssemarket  — redirect to SSE Market OAuth2
# ---------------------------------------------------------------------------

@auth_bp.route("/oauth/ssemarket", methods=["GET"])
def oauth_ssemarket():
    """Redirect browser to SSE Market OAuth2 authorize endpoint."""
    callback_path = "/oauth/callback/ssemarket"
    url = oauth2_login.ssemarket_authorize_redirect(callback_path)
    return redirect(url)


# ---------------------------------------------------------------------------
# GET /api/auth/oauth/unisso  — redirect to UniSSO OAuth2
# ---------------------------------------------------------------------------

@auth_bp.route("/oauth/unisso", methods=["GET"])
def oauth_unisso():
    """Redirect browser to UniSSO OAuth2 authorize endpoint."""
    callback_path = "/oauth/callback/unisso"
    url = oauth2_login.unisso_authorize_redirect(callback_path)
    return redirect(url)


# ---------------------------------------------------------------------------
# GET /api/auth/callback/ssemarket  — SSE Market OAuth2 callback
# ---------------------------------------------------------------------------

@auth_bp.route("/callback/ssemarket", methods=["GET"])
def callback_ssemarket():
    """Handle SSE Market OAuth2 callback (login or bind).

    This is a browser redirect flow — on success the user is redirected
    to the dashboard; on failure back to the login page.
    """
    code = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")

    if error:
        log.warning("ssemarket OAuth error: %s", error)
        return redirect("/login?oauth_error=ssemarket")

    if not code or not state:
        log.warning("ssemarket OAuth callback missing params")
        return redirect("/login?oauth_error=missing_params")

    # verify state
    st = oauth2_login._consume_state(state)
    if not st or st.get("provider") != "ssemarket":
        log.warning("ssemarket OAuth state verification failed")
        return redirect("/login?oauth_error=invalid_state")

    intent = st.get("intent", "login")

    try:
        redirect_uri = f"{oauth2_login.YATERRA_BASE_URL}/oauth/callback/ssemarket"
        token_data = oauth2_login.ssemarket_exchange_code(code, redirect_uri)
        access_token = token_data.get("access_token")
        if not access_token:
            log.error("ssemarket OAuth: no access_token in response")
            return redirect("/login?oauth_error=no_token")

        userinfo = oauth2_login.ssemarket_fetch_userinfo(access_token)
        user_id = str(userinfo.get("user_id", ""))
        name = userinfo.get("name", "") or f"ssemarket_{user_id}"
        email = userinfo.get("email", "")
        avatar = userinfo.get("avatar_url", "")

        # --- BIND mode ---
        if intent == "bind":
            bind_user = st.get("bind_username")
            if not bind_user or session.get("user") != bind_user:
                return redirect("/profile?bind_error=session_mismatch")
            ok, err = users.bind_identity(bind_user, "ssemarket", user_id,
                                          name, email, avatar)
            if not ok:
                return redirect(f"/profile?bind_error={err}")
            audit.record("oauth_bind", detail=f"ssemarket:{user_id}->{bind_user}")
            return redirect("/profile?bind_ok=ssemarket")

        # --- LOGIN mode ---
        bound_user = users.find_user_by_identity("ssemarket", user_id)
        existing = None
        if bound_user:
            username = bound_user
            existing = users.get_user(username)
            if not existing:
                bound_user = None

        if not bound_user:
            # auto-provision with sse_ prefix
            username = f"sse_{user_id}"
            existing = users.get_user(username)
            if not existing:
                users.create_user(username, secrets.token_urlsafe(24), role="user")
                existing = users.get_user(username)
            # auto-bind so future logins recognize this identity
            users.bind_identity(username, "ssemarket", user_id, name, email, avatar)

        # log in
        ip = request.remote_addr or "unknown"
        _set_login_session(username, existing or {"username": username, "role": "user"})
        session["oauth_provider"] = "ssemarket"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        audit.record("login_oauth", detail=f"ssemarket:{username}({name}) ip={ip}")

        return redirect("/")

    except Exception as e:
        log.exception("ssemarket OAuth2 callback error")
        return redirect(f"/login?oauth_error={e}")


# ---------------------------------------------------------------------------
# GET /api/auth/callback/unisso  — UniSSO OAuth2 callback
# ---------------------------------------------------------------------------

@auth_bp.route("/callback/unisso", methods=["GET"])
def callback_unisso():
    """Handle UniSSO OAuth2 callback (login or bind).

    This is a browser redirect flow — on success the user is redirected
    to the dashboard; on failure back to the login page.
    """
    code = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")

    if error:
        log.warning("unisso OAuth error: %s", error)
        return redirect("/login?oauth_error=unisso")

    if not code or not state:
        log.warning("unisso OAuth callback missing params")
        return redirect("/login?oauth_error=missing_params")

    # verify state and get PKCE verifier
    st = oauth2_login._consume_state(state)
    if not st or st.get("provider") != "unisso":
        log.warning("unisso OAuth state verification failed")
        return redirect("/login?oauth_error=invalid_state")

    code_verifier = st.get("code_verifier", "")
    intent = st.get("intent", "login")

    try:
        redirect_uri = f"{oauth2_login.YATERRA_BASE_URL}/oauth/callback/unisso"
        token_data = oauth2_login.unisso_exchange_code(code, redirect_uri, code_verifier)
        access_token = token_data.get("access_token")
        if not access_token:
            log.error("unisso OAuth: no access_token in response")
            return redirect("/login?oauth_error=no_token")

        userinfo = oauth2_login.unisso_fetch_userinfo(access_token)
        user_id = str(userinfo.get("sub", userinfo.get("user_id", "")))
        name = userinfo.get("name", "") or userinfo.get("username", "") or f"unisso_{user_id}"
        email = userinfo.get("email", "")
        avatar = userinfo.get("picture", "") or userinfo.get("avatar", "")

        # --- BIND mode ---
        if intent == "bind":
            bind_user = st.get("bind_username")
            if not bind_user or session.get("user") != bind_user:
                return redirect("/profile?bind_error=session_mismatch")
            ok, err = users.bind_identity(bind_user, "unisso", user_id,
                                          name, email, avatar)
            if not ok:
                return redirect(f"/profile?bind_error={err}")
            audit.record("oauth_bind", detail=f"unisso:{user_id}->{bind_user}")
            return redirect("/profile?bind_ok=unisso")

        # --- LOGIN mode ---
        bound_user = users.find_user_by_identity("unisso", user_id)
        existing = None
        if bound_user:
            username = bound_user
            existing = users.get_user(username)
            if not existing:
                bound_user = None

        if not bound_user:
            # auto-provision with uni_ prefix
            username = f"uni_{user_id}"
            existing = users.get_user(username)
            if not existing:
                users.create_user(username, secrets.token_urlsafe(24), role="user")
                existing = users.get_user(username)
            # auto-bind so future logins recognize this identity
            users.bind_identity(username, "unisso", user_id, name, email, avatar)

        # log in
        ip = request.remote_addr or "unknown"
        _set_login_session(username, existing or {"username": username, "role": "user"})
        session["oauth_provider"] = "unisso"
        session["oauth_name"] = name
        session["oauth_email"] = email
        session["oauth_avatar"] = avatar
        audit.record("login_oauth", detail=f"unisso:{username}({name}) ip={ip}")

        return redirect("/")

    except Exception as e:
        log.exception("unisso OAuth2 callback error")
        return redirect(f"/login?oauth_error={e}")
