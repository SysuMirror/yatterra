"""CSRF protection for API endpoints (session-based requests)."""
from flask import request, session, jsonify
from functools import wraps
import secrets


def generate_csrf_token():
    """Generate and store a CSRF token in the session."""
    if "_csrf_token" not in session:
        session["_csrf_token"] = secrets.token_hex(32)
    return session["_csrf_token"]


def get_csrf_token():
    """Get the current CSRF token from session (or generate one)."""
    return generate_csrf_token()


def require_csrf(f):
    """Decorator that validates CSRF token on mutating requests.
    Checks X-CSRF-Token header against session token.
    Skips check for safe methods (GET, HEAD, OPTIONS).
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return f(*args, **kwargs)
        token = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
        session_token = session.get("_csrf_token")
        if not token or not session_token or token != session_token:
            return jsonify({"error": {"code": "CSRF_FAILED", "message": "CSRF token mismatch"}}), 403
        return f(*args, **kwargs)
    return decorated
