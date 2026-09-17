"""OAuth2 login integration for ssemarket and UniSSO.

Adds two external login methods to the yatterra platform:
  1. SSE Market OAuth2  — ssemarket.cn/new/connect flow
  2. UniSSO OAuth2      — UniSSO /authorize flow (with PKCE)

Both follow the Authorization Code grant type.
"""
import os
import time
import secrets
import hashlib
import base64
import json
import urllib.parse
import logging

import requests

log = logging.getLogger("oauth2")

# ---------------------------------------------------------------------------
# Configuration — read from env vars with sensible defaults for this deploy
# ---------------------------------------------------------------------------

import siteconf

_SSO_HOST = f"https://sso.{siteconf.DOMAIN}"
_RELAY = f"https://{siteconf.PUBLIC_HOST}"

# SSE Market OAuth2  (secrets have NO default — set them in .env)
SSEMARKET_APP_ID = os.environ.get("SSEMARKET_OAUTH_APP_ID", "yatterra")
SSEMARKET_APP_SECRET = os.environ.get("SSEMARKET_OAUTH_APP_SECRET", "")
SSEMARKET_AUTHORIZE_URL = os.environ.get(
    "SSEMARKET_OAUTH_AUTHORIZE_URL", f"{_SSO_HOST}/authorize"
)
SSEMARKET_TOKEN_URL = os.environ.get(
    "SSEMARKET_OAUTH_TOKEN_URL", f"{_RELAY}/api/auth/connect/token"
)
SSEMARKET_USERINFO_URL = os.environ.get(
    "SSEMARKET_OAUTH_USERINFO_URL", f"{_RELAY}/api/auth/connect/userinfo"
)
SSEMARKET_SCOPE = os.environ.get("SSEMARKET_OAUTH_SCOPE", "read_basic")

# UniSSO OAuth2  (secrets have NO default — set them in .env)
UNISSO_CLIENT_ID = os.environ.get("UNISSO_OAUTH_CLIENT_ID", "")
UNISSO_CLIENT_SECRET = os.environ.get("UNISSO_OAUTH_CLIENT_SECRET", "")
# Authorize URL must be public (browser redirects there), but token/userinfo
# can use the local ClusterIP/NodePort to avoid going through frp.
UNISSO_AUTHORIZE_URL = os.environ.get(
    "UNISSO_OAUTH_AUTHORIZE_URL", f"{_SSO_HOST}/authorize"
)
UNISSO_TOKEN_URL = os.environ.get(
    "UNISSO_OAUTH_TOKEN_URL", "http://127.0.0.1:32004/api/oauth/token"
)
UNISSO_USERINFO_URL = os.environ.get(
    "UNISSO_OAUTH_USERINFO_URL", "http://127.0.0.1:32004/api/oauth/userinfo"
)
UNISSO_SCOPE = os.environ.get("UNISSO_OAUTH_SCOPE", "openid profile email")

# Base URL of this yatterra instance (for building redirect_uri)
YATERRA_BASE_URL = os.environ.get(
    "YATERRA_BASE_URL", siteconf.public_url(14000)
)

# ---------------------------------------------------------------------------
# In-memory state store  (good enough for single-worker gunicorn)
# ---------------------------------------------------------------------------

_oauth_states: dict[str, dict] = {}   # state -> {provider, created_at, ...}
_STATE_TTL = 600  # 10 minutes


def _cleanup_states():
    now = time.time()
    expired = [k for k, v in _oauth_states.items() if now - v["created_at"] > _STATE_TTL]
    for k in expired:
        _oauth_states.pop(k, None)


def _generate_state(provider: str, extra: dict | None = None) -> str:
    _cleanup_states()
    state = secrets.token_urlsafe(32)
    entry = {"provider": provider, "created_at": time.time()}
    if extra:
        entry.update(extra)
    _oauth_states[state] = entry
    return state


def _consume_state(state: str) -> dict | None:
    entry = _oauth_states.pop(state, None)
    if not entry:
        return None
    if time.time() - entry["created_at"] > _STATE_TTL:
        return None
    return entry


# ---------------------------------------------------------------------------
# PKCE helpers (for UniSSO)
# ---------------------------------------------------------------------------

def _generate_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge)."""
    verifier = secrets.token_urlsafe(48)
    challenge_bytes = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(challenge_bytes).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------------------
# SSE Market OAuth2 flow
# ---------------------------------------------------------------------------

def ssemarket_authorize_redirect(callback_path: str,
                                  intent: str = "login",
                                  bind_username: str | None = None) -> str:
    """Build the redirect URL to ssemarket.cn/new/connect for SSE Market login.

    Uses the ssemarket OAuth protocol (appid + app_id, no PKCE).
    The callback uses the ssemarket path so the user is created with
    the ``sse_`` prefix.

    intent: "login" (default) or "bind" (when binding from profile page).
    bind_username: required when intent="bind" — the yatterra user to bind to.
    """
    redirect_uri = f"{YATERRA_BASE_URL}{callback_path}"
    extra = {"intent": intent}
    if intent == "bind" and bind_username:
        extra["bind_username"] = bind_username
    state = _generate_state("ssemarket", extra)
    params = {
        "appid": SSEMARKET_APP_ID,
        "app_id": SSEMARKET_APP_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SSEMARKET_SCOPE,
        "state": state,
    }
    return f"{SSEMARKET_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def ssemarket_exchange_code(code: str, redirect_uri: str) -> dict:
    """Exchange authorization code for access token."""
    resp = requests.post(
        SSEMARKET_TOKEN_URL,
        data={
            "code": code,
            "appid": SSEMARKET_APP_ID,
            "app_id": SSEMARKET_APP_ID,
            "app_secret": SSEMARKET_APP_SECRET,
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    # ssemarket wraps in {code, data, msg}
    if "data" in data and isinstance(data["data"], dict):
        return data["data"]
    return data


def ssemarket_fetch_userinfo(access_token: str) -> dict:
    """Fetch user info from ssemarket."""
    resp = requests.post(
        SSEMARKET_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    if "data" in data and isinstance(data["data"], dict):
        return data["data"]
    return data


# ---------------------------------------------------------------------------
# UniSSO OAuth2 flow
# ---------------------------------------------------------------------------

def unisso_authorize_redirect(callback_path: str,
                               intent: str = "login",
                               bind_username: str | None = None) -> str:
    """Build the redirect URL to UniSSO /authorize.

    intent: "login" (default) or "bind" (when binding from profile page).
    bind_username: required when intent="bind" — the yatterra user to bind to.
    """
    redirect_uri = f"{YATERRA_BASE_URL}{callback_path}"
    verifier, challenge = _generate_pkce()
    extra = {"code_verifier": verifier, "intent": intent}
    if intent == "bind" and bind_username:
        extra["bind_username"] = bind_username
    state = _generate_state("unisso", extra)
    params = {
        "client_id": UNISSO_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": UNISSO_SCOPE,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{UNISSO_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def unisso_exchange_code(code: str, redirect_uri: str, code_verifier: str) -> dict:
    """Exchange authorization code for access token."""
    resp = requests.post(
        UNISSO_TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": UNISSO_CLIENT_ID,
            "client_secret": UNISSO_CLIENT_SECRET,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def unisso_fetch_userinfo(access_token: str) -> dict:
    """Fetch user info from UniSSO."""
    resp = requests.get(
        UNISSO_USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()
