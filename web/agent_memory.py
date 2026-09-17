"""Agent cross-session memory.

Stores key-value pairs per namespace (e.g. "ops", "build:pod-cpupod")
in /opt/yatterra/agent_memory.json (root 600, atomic write).

Usage:
  save("ops", "last_check:anomalies", "pod-xxx:OOMKilled")
  load("ops", "last_check:anomalies")  → "pod-xxx:OOMKilled"
  list_keys("ops")  → ["last_check:anomalies", "frpc_status", ...]
"""
import json
import os
import threading
from datetime import datetime

import siteconf

STATE_FILE = siteconf.path("agent_memory.json")
MAX_VALUE_LEN = 4000  # per value, prevent abuse
MAX_KEYS_PER_NS = 50  # per namespace

_lock = threading.Lock()


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _load():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save(data):
    _atomic_write(STATE_FILE, data)


def save(namespace, key, value):
    """Save a memory entry. namespace = agent id or agent:pod, key = short label."""
    value = str(value)[:MAX_VALUE_LEN]
    with _lock:
        data = _load()
        ns = data.setdefault(namespace, {})
        ns[key] = {"v": value, "ts": datetime.utcnow().isoformat()}
        # evict oldest if too many keys
        if len(ns) > MAX_KEYS_PER_NS:
            oldest = sorted(ns.items(), key=lambda x: x[1].get("ts", ""))[:len(ns) - MAX_KEYS_PER_NS]
            for k, _ in oldest:
                del ns[k]
        _save(data)


def load(namespace, key):
    """Load a memory entry. Returns value string or None."""
    with _lock:
        data = _load()
    return (data.get(namespace, {}).get(key, {}) or {}).get("v")


def list_keys(namespace):
    """List all keys in a namespace with timestamps. Returns [{key, value, ts}]."""
    with _lock:
        data = _load()
    ns = data.get(namespace, {})
    return [{"key": k, "value": v.get("v", ""), "ts": v.get("ts", "")} for k, v in ns.items()]


def delete(namespace, key):
    """Delete a memory entry."""
    with _lock:
        data = _load()
        ns = data.get(namespace, {})
        if key in ns:
            del ns[key]
            _save(data)
