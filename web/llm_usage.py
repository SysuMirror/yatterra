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

# Per-user daily token ceiling for the chat entries. Configurable via env;
# the default is deliberately LARGE so normal use is never blocked. Set <= 0
# to disable the check entirely.
DAILY_TOKEN_LIMIT = int(os.environ.get("LLM_DAILY_TOKEN_LIMIT", "5000000") or 0)

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


QUOTA_WARN_PCT = 80  # 日配额使用率达到该百分比时预警一次


def _mark_quota_warned(user, day):
    """当日已预警则返回 False; 否则落盘标记并返回 True(本次应发预警)。"""
    with _lock:
        data = _load()
        warned = data.setdefault("_quota_warn", {}).setdefault(day, {})
        if user in warned:
            return False
        warned[user] = True
        # 与 _day_index 同步裁剪, 防止 _quota_warn 无限增长
        for key in ("_quota_warn",):
            idx = data.get(key, {})
            for d in [d for d in idx if d < day]:
                del idx[d]
        _save(data)
        return True


def _notify_quota_warn(user, percent):
    """配额预警推送(kind='quota-warn')。收件人是单个用户, notify_event 按组
    解析发不到, 走 cert_alerts.notify_user 直发(_claim_alert 去重留痕)。"""
    try:
        import cert_alerts
        cert_alerts.notify_user(
            user, f"quota-warn:{user}:{_today()}", "quota-warn",
            "AI 用量预警",
            f"今日 AI 用量已达 {percent}%, 接近日配额, 请留意。",
            url="/profile", urgency="low")
    except Exception:
        pass


def check_quota(user, limit=None):
    """Return ``(ok, used, limit)`` for a user's *today* token usage.

    ``ok`` is False only when the user has reached the daily ceiling. A
    ``limit`` of None uses DAILY_TOKEN_LIMIT; ``limit <= 0`` (or an empty
    user) disables the check. Never raises — any failure is treated as
    "allow", so a usage-tracking problem can never block real traffic.

    附带配额预警: 使用率 >= QUOTA_WARN_PCT% 且当日未预警过时, 异步推送该
    用户一次(kind='quota-warn', 标记落盘在 usage 数据的 _quota_warn 里)。
    """
    try:
        if limit is None:
            limit = DAILY_TOKEN_LIMIT
        if not user or not limit or limit <= 0:
            return True, 0, limit
        with _lock:
            data = _load()
        bucket = (data.get("_day_index", {}).get(_today(), {}) or {}).get(user) or {}
        used = bucket.get("total", 0)
        # 配额预警(best-effort, 永不影响配额判定)
        try:
            percent = int(used * 100 / limit)
            if percent >= QUOTA_WARN_PCT and _mark_quota_warned(user, _today()):
                import threading
                threading.Thread(target=_notify_quota_warn,
                                 args=(user, percent), daemon=True).start()
        except Exception:
            pass
        return used < limit, used, limit
    except Exception:
        return True, 0, limit


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
