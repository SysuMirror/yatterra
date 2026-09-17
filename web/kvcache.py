#!/usr/bin/env python3
"""Redis-backed TTL cache for k3s/metrics data.

Provides a simple cache-aside pattern: get/set/get_or_compute.
Falls back gracefully if Redis is unavailable — callers just skip the
cache and compute directly, identical to pre-cache behavior.

Redis connection is lazy and auto-discovered:
  1. REDIS_HOST / REDIS_PORT / REDIS_PASSWORD env vars
  2. kubectl to find the Redis pod IP in platform-infra namespace
  3. /opt/yatterra/db_creds.json for the password

All keys are prefixed with ``yt:`` to avoid colliding with Flask
session keys (``g<hash>:session:*``) already stored in the same Redis.
"""
import json
import logging
import os
import subprocess
import threading

import siteconf

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Redis connection (lazy singleton)
# ---------------------------------------------------------------------------
_redis = None
_redis_lock = threading.Lock()
_PREFIX = "yt:"
_SENTINEL = object()  # internal marker for "tried and failed"


def _get_redis():
    """Return connected Redis instance, or None if unavailable.

    Thread-safe; connection is attempted once and cached.
    """
    global _redis
    if _redis is not None and _redis is not _SENTINEL:
        return _redis
    if _redis is _SENTINEL:
        return None
    with _redis_lock:
        if _redis is not None and _redis is not _SENTINEL:
            return _redis
        if _redis is _SENTINEL:
            return None
        try:
            import redis as _redis_mod

            host = os.environ.get("REDIS_HOST", "")
            port = int(os.environ.get("REDIS_PORT", "6379") or "6379")
            password = os.environ.get("REDIS_PASSWORD", "")

            # Auto-discover host via kubectl if not set
            if not host:
                try:
                    r = subprocess.run(
                        [
                            "kubectl", "-n", "platform-infra", "get", "pod",
                            "-l", "app=redis",
                            "-o", "jsonpath={.items[0].status.podIP}",
                        ],
                        capture_output=True, text=True, timeout=5,
                    )
                    if r.returncode == 0 and r.stdout.strip():
                        host = r.stdout.strip()
                except Exception:
                    pass

            # Auto-discover password: try creds file, then k8s secret
            if not password:
                try:
                    with open(siteconf.path("db_creds.json")) as f:
                        creds = json.load(f)
                    password = creds.get("redis_password", "")
                except Exception:
                    pass
            if not password:
                try:
                    import base64 as _b64
                    r = subprocess.run(
                        [
                            "kubectl", "-n", "platform-infra", "get", "secret",
                            "db-creds", "-o", "jsonpath={.data.REDIS_PASSWORD}",
                        ],
                        capture_output=True, text=True, timeout=5,
                    )
                    if r.returncode == 0 and r.stdout.strip():
                        password = _b64.b64decode(r.stdout.strip()).decode()
                except Exception:
                    pass

            if host and password:
                _redis = _redis_mod.Redis(
                    host=host, port=port, password=password,
                    decode_responses=True,
                    socket_timeout=3,
                    socket_connect_timeout=3,
                )
                _redis.ping()
                log.info("kvcache: Redis connected %s:%d", host, port)
                return _redis
            else:
                log.warning("kvcache: no Redis host/password found, running in memory-only mode")
                _redis = _SENTINEL
        except Exception as e:
            log.warning("kvcache: Redis unavailable, falling back to no-cache: %s", e)
            _redis = _SENTINEL
    return None


def reset():
    """Force re-discovery of Redis (useful after connectivity changes)."""
    global _redis
    with _redis_lock:
        _redis = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get(key, default=None):
    """Get a cached value by key. Returns parsed Python object or *default*."""
    r = _get_redis()
    if r:
        try:
            raw = r.get(_PREFIX + key)
            if raw is not None:
                return json.loads(raw)
        except Exception:
            pass
    return default


def set(key, value, ttl=10):
    """Store *value* under *key* with TTL in seconds. Returns True on success."""
    r = _get_redis()
    if r:
        try:
            r.setex(_PREFIX + key, ttl, json.dumps(value, ensure_ascii=False))
            return True
        except Exception:
            pass
    return False


def delete(key):
    """Remove a cached key."""
    r = _get_redis()
    if r:
        try:
            r.delete(_PREFIX + key)
        except Exception:
            pass


def get_or_compute(key, compute_fn, ttl=10):
    """Cache-aside: return cached value or compute, store, and return it.

    *compute_fn* is only called on cache miss. If it returns None the
    result is NOT cached (avoids caching empty/error results).
    """
    val = get(key)
    if val is not None:
        return val
    val = compute_fn()
    if val is not None:
        set(key, val, ttl)
    return val


def keys(pattern="*"):
    """List cached keys matching *pattern* (for debugging)."""
    r = _get_redis()
    if r:
        try:
            raw = r.keys(_PREFIX + pattern)
            return [k[len(_PREFIX):] for k in raw]
        except Exception:
            pass
    return []
