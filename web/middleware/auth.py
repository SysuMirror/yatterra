"""Authentication middleware for API endpoints.
Supports both session-based (browser) and token-based (API) auth.
"""
from flask import request, session, jsonify, g
from functools import wraps


def get_current_user():
    """Get the current logged-in username from session."""
    return session.get("user")


def get_user_perms():
    """Get the current user's permissions set from session."""
    return session.get("perms", set())


def get_user_role():
    """Get the current user's role from session."""
    return session.get("role", "")


def is_logged_in():
    """Check if a user is currently logged in."""
    return bool(session.get("logged_in"))


def require_login(f):
    """Decorator that requires an authenticated session."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not is_logged_in():
            return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Login required"}}), 401
        return f(*args, **kwargs)
    return decorated


def require_perm(perm):
    """Decorator that requires a specific permission."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not is_logged_in():
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Login required"}}), 401
            perms = get_user_perms()
            if perm not in perms and "super" not in perms:
                return jsonify({"error": {"code": "FORBIDDEN", "message": f"Permission '{perm}' required"}}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def require_any_perm(*perms):
    """Decorator that requires any of the specified permissions."""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not is_logged_in():
                return jsonify({"error": {"code": "UNAUTHORIZED", "message": "Login required"}}), 401
            user_perms = get_user_perms()
            if not (set(perms) & user_perms) and "super" not in user_perms:
                return jsonify({"error": {"code": "FORBIDDEN", "message": "One of permissions required: " + ", ".join(perms)}}), 403
            return f(*args, **kwargs)
        return decorated
    return decorated


def inject_auth_context(app):
    """Inject auth context into all requests (user, perms, role)."""
    @app.before_request
    def set_auth_context():
        g.current_user = get_current_user()
        g.user_perms = get_user_perms()
        g.user_role = get_user_role()
        g.is_logged_in = is_logged_in()
