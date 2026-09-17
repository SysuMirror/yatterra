"""LLM token usage tracker.

Records per-call token usage and provides aggregation queries.
Data stored in /opt/yatterra/llm_usage.json (root 600, atomic write).

Indexes:
  _day_index: {date: {user: {prompt,completion,total,calls}}}
  _component_index: {date: {component: {prompt,completion,total,calls}}}

Auto-prunes: keeps last 30 days of daily indexes, last 500 individual calls.
"""
import json
import os
import threading
from datetime import datetime, timedelta

import siteconf

STATE_FILE = siteconf.path("llm_usage.json")
MAX_CALLS = 500
MAX_DAYS = 30

_lock = threading.Lock()


def _today():
    return datetime.utcnow().strftime("%Y-%m-%d")


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
        return {"calls": [], "_day_index": {}, "_component_index": {}}


def _save(data):
    _atomic_write(STATE_FILE, data)


def _add_to_bucket(bucket, prompt, completion):
    """Increment a {prompt,completion,total,calls} bucket."""
    bucket["prompt"] = bucket.get("prompt", 0) + prompt
    bucket["completion"] = bucket.get("completion", 0) + completion
    bucket["total"] = bucket.get("total", 0) + prompt + completion
    bucket["calls"] = bucket.get("calls", 0) + 1


def _prune_days(data, max_days=MAX_DAYS):
    """Remove daily/component index entries older than max_days."""
    cutoff = (datetime.utcnow() - timedelta(days=max_days)).strftime("%Y-%m-%d")
    for key in ("_day_index", "_component_index"):
        idx = data.get(key, {})
        old = [d for d in idx if d < cutoff]
        for d in old:
            del idx[d]


def _prune_calls(data, max_calls=MAX_CALLS):
    """Keep only the last max_calls entries."""
    calls = data.get("calls", [])
    if len(calls) > max_calls:
        data["calls"] = calls[-max_calls:]


def record(user, component, provider_id, model, prompt_tokens, completion_tokens):
    """Record one LLM call's usage. Updates calls list and daily/component indexes."""
    with _lock:
        data = _load()
        total = prompt_tokens + completion_tokens
        day = _today()

        # Append to calls
        data.setdefault("calls", []).append({
            "ts": datetime.utcnow().isoformat(),
            "user": user or "system",
            "component": component or "unknown",
            "provider_id": provider_id or "",
            "model": model or "",
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total,
        })

        # Update day_index
        di = data.setdefault("_day_index", {})
        day_bucket = di.setdefault(day, {})
        _add_to_bucket(day_bucket.setdefault(user or "system", {}), prompt_tokens, completion_tokens)

        # Update component_index
        ci = data.setdefault("_component_index", {})
        comp_bucket = ci.setdefault(day, {})
        _add_to_bucket(comp_bucket.setdefault(component or "unknown", {}), prompt_tokens, completion_tokens)

        # Prune and save
        _prune_days(data)
        _prune_calls(data)
        _save(data)


def day_summary(days=7):
    """Return {date: {user: {prompt,completion,total,calls}}} for last N days."""
    with _lock:
        data = _load()
    di = data.get("_day_index", {})
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    return {d: v for d, v in di.items() if d >= cutoff}


def component_summary(days=7):
    """Return {date: {component: {prompt,completion,total,calls}}} for last N days."""
    with _lock:
        data = _load()
    ci = data.get("_component_index", {})
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    return {d: v for d, v in ci.items() if d >= cutoff}


def top_users(days=7, limit=20):
    """Return [{user, prompt, completion, total, calls}] top N users by total tokens."""
    ds = day_summary(days)
    agg = {}
    for day_data in ds.values():
        for user, bucket in day_data.items():
            a = agg.setdefault(user, {"prompt": 0, "completion": 0, "total": 0, "calls": 0})
            a["prompt"] += bucket.get("prompt", 0)
            a["completion"] += bucket.get("completion", 0)
            a["total"] += bucket.get("total", 0)
            a["calls"] += bucket.get("calls", 0)
    result = [{"user": u, **v} for u, v in agg.items()]
    result.sort(key=lambda x: x["total"], reverse=True)
    return result[:limit]


def user_summary(username, days=7):
    """Return {prompt, completion, total, calls} for one user over N days."""
    ds = day_summary(days)
    agg = {"prompt": 0, "completion": 0, "total": 0, "calls": 0}
    for day_data in ds.values():
        bucket = day_data.get(username, {})
        agg["prompt"] += bucket.get("prompt", 0)
        agg["completion"] += bucket.get("completion", 0)
        agg["total"] += bucket.get("total", 0)
        agg["calls"] += bucket.get("calls", 0)
    return agg


def recent_calls(n=50):
    """Return last N calls (newest first)."""
    with _lock:
        data = _load()
    calls = data.get("calls", [])
    return list(reversed(calls[-n:]))


def total_summary(days=7):
    """Return {prompt, completion, total, calls} across all users for N days."""
    ds = day_summary(days)
    agg = {"prompt": 0, "completion": 0, "total": 0, "calls": 0}
    for day_data in ds.values():
        for bucket in day_data.values():
            agg["prompt"] += bucket.get("prompt", 0)
            agg["completion"] += bucket.get("completion", 0)
            agg["total"] += bucket.get("total", 0)
            agg["calls"] += bucket.get("calls", 0)
    return agg
