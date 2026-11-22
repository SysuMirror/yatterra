"""Shared authentication helpers for API blueprints.

Supports both Bearer token (API clients) and session (browser AJAX) auth.
"""
import functools
import os
import time
from importlib import import_module
from flask import request, jsonify, g, session
users = import_module("users")


# 角色等级:用于"最低角色"闸(与 ai_service._ROLE_RANK 同构)。
_ROLE_RANK = {"guest": 0, "user": 1, "admin": 2, "super": 3}

# 会话绝对最大生命周期。Flask 的永久会话是"滑动续期"的——每次请求都会带着
# 新的 7 天有效期重签 Set-Cookie, 因此被盗 cookie 等于永久凭据(ARTEX finding:
# 会话无限滑动续期)。这里额外记录一个不随请求续期的登录起点 _login_at, 超过
# 绝对上限即强制失效(需重新登录), 与滑动窗口无关。
# 环境变量 YATTERRA_SESSION_MAX_AGE_S 可调, 默认 7 天。
SESSION_MAX_AGE_S = int(os.environ.get("YATTERRA_SESSION_MAX_AGE_S",
                                       str(7 * 24 * 3600)))


def session_age_exceeded(sess=None):
    """会话是否已超过绝对最大生命周期。无 _login_at 的旧会话 → 不判过期。"""
    s = session if sess is None else sess
    try:
        ts = float(s.get("_login_at"))
    except (TypeError, ValueError):
        return False
    return (time.time() - ts) > SESSION_MAX_AGE_S


def role_rank(user):
    """用户 dict 的角色等级;未认证/None → -1(交由 @require_auth 出 401)。"""
    if not isinstance(user, dict):
        return -1
    return _ROLE_RANK.get(user.get("role") or "guest", 0)


def min_role_guard(min_role="user"):
    """Blueprint before_request 守卫:已认证但角色低于 min_role → 403。

    匿名调用放行(返回 None),以便路由自身的 @require_auth 给出 401。
    """
    u = _resolve_user()
    if u is not None and role_rank(u) < _ROLE_RANK.get(min_role, 1):
        return jsonify({"error": {"code": "FORBIDDEN",
                                  "message": f"需要至少 {min_role} 角色"}}), 403
    return None


def _resolve_user():
    """Resolve user from Bearer token or session.

    Returns user dict (as returned by users.get_user) or None.
    Cached on flask.g per request.
    DB errors are caught so a stale connection never causes a 500.
    """
    if hasattr(g, "_api_user_cache"):
        return g._api_user_cache
    # Try Bearer token first
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        try:
            info = users.verify_token(token)
        except Exception:
            info = None
        if info:
            g._api_user_cache = info
            return info
    # Fall back to session
    if session.get("logged_in"):
        # 绝对生命周期闸: 超期即清会话 → 走 401, 杜绝滑动续期造成的永久凭据。
        if session_age_exceeded():
            session.clear()
            g._api_user_cache = None
            return None
        username = session.get("user")
        if username:
            try:
                u = users.get_user(username)
            except Exception:
                u = None
            if u:
                g._api_user_cache = u
                return u
    g._api_user_cache = None
    return None


def require_auth(perm=None, min_role=None):
    """Decorator: require authentication (token or session) + optional permission.

    Injects g.api_user = user_dict on success.
    DB errors in has_perm are caught to prevent 500s from stale connections.
    min_role: 可选最低角色(如 "user" 即封禁 guest);未认证仍返回 401。
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            u = _resolve_user()
            if not u:
                return jsonify({"error": {"code": "UNAUTHORIZED",
                                          "message": "Authentication required"}}), 401
            if min_role and role_rank(u) < _ROLE_RANK.get(min_role, 1):
                return jsonify({"error": {"code": "FORBIDDEN",
                                          "message": f"需要至少 {min_role} 角色"}}), 403
            if perm:
                try:
                    has = users.has_perm(u, perm)
                except Exception:
                    # DB error — deny by default rather than 500
                    has = False
                if not has:
                    return jsonify({"error": {"code": "FORBIDDEN",
                                              "message": f"Permission denied: {perm}"}}), 403
            g.api_user = u
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def require_pod(level="member"):
    """Decorator: require pod access at the given level.

    Pod name is the first URL parameter.  Must be used after require_auth
    (or chains internally).  Injects g.api_pod = pod_dict.
    """
    import groups as groups_mod

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(name, *args, **kwargs):
            u = _resolve_user()
            if not u:
                return jsonify({"error": {"code": "UNAUTHORIZED",
                                          "message": "Authentication required"}}), 401
            g.api_user = u
            # guest(零凭据自助、全局共享的 principal)对 /api/pods/* 没有任何合法
            # 访问面。这里不进入存在性判断就返回统一的 403——否则「存在的 Pod → 403、
            # 不存在的 Pod → 404」的差分会被用来枚举全平台 Pod 是否存在
            # (ARTEX finding: /api/pods/{name} 存在性预言机)。匿名调用仍是 401(统一)。
            # 只封「明确为 guest 角色」的 principal:不要用角色等级比较——那会把
            # 任何 role 字段缺省的用户 dict 一律误判成 guest(rank 0)而误杀。
            if (u.get("role") or "").lower() == "guest":
                return jsonify({"error": {"code": "FORBIDDEN",
                                          "message": "需要至少 user 角色"}}), 403
            pod = groups_mod.load_state()["groups"].get(name)
            if not pod:
                return jsonify({"error": {"code": "NOT_FOUND",
                                          "message": f"Pod {name} not found"}}), 404
            try:
                can = users.can_pod(u, pod, level)
            except Exception:
                can = False
            if not can:
                return jsonify({"error": {"code": "FORBIDDEN",
                                          "message": f"Access denied for Pod {name}"}}), 403
            g.api_pod = pod
            return fn(name, *args, **kwargs)
        return wrapper
    return decorator


def current_username():
    """Return the current authenticated username, or None."""
    u = getattr(g, "api_user", None) or _resolve_user()
    return u.get("username") if u else None


def current_user_obj():
    """Return the current authenticated user dict, or None."""
    return getattr(g, "api_user", None) or _resolve_user()
