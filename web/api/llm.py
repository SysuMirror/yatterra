"""LLM API blueprint — /api/llm

LLM provider management and usage statistics.
"""
import os
from urllib.parse import urlparse

import requests
from flask import Blueprint, request, jsonify
from middleware.error_handler import bad_request, not_found, forbidden

import llm_conf
import llm_usage
import metrics
import audit

from api._auth import require_auth, current_username, current_user_obj

llm_bp = Blueprint("api_llm", __name__, url_prefix="/api/llm")

# Cloud metadata endpoints we refuse to probe (token SSRF guard). Intranet
# addresses are intentionally NOT blocked — real providers live there.
_BLOCKED_PROBE_HOSTS = {
    h.strip().lower()
    for h in os.environ.get(
        "LLM_MODEL_PROBE_BLOCK_HOSTS", "169.254.169.254,metadata.google.internal"
    ).split(",")
    if h.strip()
}


def _probe_models(base_url, api_key, timeout=15):
    """GET ``{base_url}/models`` for an OpenAI-compatible endpoint.

    Returns ``(ok, models, message)``. Never raises for upstream failures —
    connection problems come back as ``ok=False`` with a readable message.

    SSRF note: this is admin-only. Providers legitimately sit on private
    addresses (e.g. ``http://10.43.193.122:8000/v1``), so RFC1918 ranges are
    deliberately allowed. We only reject non-http(s) schemes, disable
    redirects, and block well-known metadata hosts.
    """
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        return False, [], "base_url 为空"
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https"):
        return False, [], "只支持 http/https 协议"
    host = (parsed.hostname or "").lower()
    if host in _BLOCKED_PROBE_HOSTS:
        return False, [], f"目标主机 {host} 不被允许"
    url = base_url + "/models"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=False)
    except requests.RequestException as e:
        return False, [], f"连接失败: {e}"
    if resp.status_code in (301, 302, 303, 307, 308):
        return False, [], f"上游重定向 (HTTP {resp.status_code})，请填写最终地址"
    if resp.status_code in (401, 403):
        return False, [], f"认证失败 (HTTP {resp.status_code})，请检查 API Key"
    if resp.status_code != 200:
        return False, [], f"上游返回 HTTP {resp.status_code}"
    try:
        data = resp.json()
        models = [m.get("id") for m in data.get("data", []) if m.get("id")]
    except ValueError:
        models = []
    if models:
        return True, models, f"连接成功，{len(models)} 个模型可用"
    return True, [], "连接成功（上游未返回模型清单）"


@llm_bp.route("/providers", methods=["GET"])
@require_auth("dev.llm")
def llm_providers():
    """List all LLM providers.

    Non-admin users see masked API keys.
    """
    _uo = current_user_obj()
    is_admin = _uo.get("role") in ("super", "admin")
    state = llm_conf.load()
    providers = state.get("providers", [])
    if not is_admin:
        providers = [
            {k: (v if k != "api_key" else (v[:4] + "****" + v[-4:] if v and len(v) > 8 else "****"))
             for k, v in p.items()}
            for p in providers
        ]
    return jsonify({"providers": providers, "active_id": state.get("active_id", "")})


@llm_bp.route("/providers/<provider_id>", methods=["PUT"])
@require_auth("dev.llm")
def llm_provider_update(provider_id):
    """Update an LLM provider.

    Body: any provider fields to update (name, base_url, api_key, model, max_context, etc.)
    """
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can update LLM providers")

    body = request.get_json(silent=True) or {}
    p = llm_conf.update_provider(provider_id, body)
    if not p:
        raise not_found(f"Provider {provider_id} not found")

    audit.record("api_llm_provider_update", detail=provider_id,
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "provider": p})


@llm_bp.route("/providers/add", methods=["POST"])
@require_auth("dev.llm")
def llm_provider_add():
    """Add a new LLM provider.

    Body: {name, type, base_url, api_key, model?, max_context?, enabled?, is_default?}
    """
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can add LLM providers")

    body = request.get_json(silent=True) or {}
    if not body.get("name"):
        raise bad_request("name is required")
    if not body.get("base_url"):
        raise bad_request("base_url is required")
    if not body.get("api_key"):
        raise bad_request("api_key is required")

    p = llm_conf.add_provider(body)
    audit.record("api_llm_provider_add", detail=p["id"],
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "provider": p})


@llm_bp.route("/providers/delete", methods=["POST"])
@require_auth("dev.llm")
def llm_provider_delete():
    """Delete a provider. Body: {id}."""
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can delete LLM providers")

    body = request.get_json(silent=True) or {}
    pid = body.get("id")
    if not pid:
        raise bad_request("id is required")

    if not llm_conf.delete_provider(pid):
        raise not_found(f"Provider {pid} not found")

    audit.record("api_llm_provider_delete", detail=pid,
                 actor=current_username() or "unknown")
    return jsonify({"ok": True})


@llm_bp.route("/providers/set-default", methods=["POST"])
@require_auth("dev.llm")
def llm_provider_set_default():
    """Set a provider as the active default. Body: {id}."""
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can change the default LLM provider")

    body = request.get_json(silent=True) or {}
    pid = body.get("id")
    if not pid:
        raise bad_request("id is required")

    p = llm_conf.set_default(pid)
    if not p:
        raise bad_request(f"Provider {pid} not found or disabled")

    audit.record("api_llm_provider_set_default", detail=pid,
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "provider": p})


@llm_bp.route("/providers/models", methods=["POST"])
@require_auth("dev.llm")
def llm_provider_models():
    """List candidate models for a provider config (used by the add/edit dialog).

    Body: ``{base_url, api_key?, id?}``. When ``id`` is given and no ``api_key``
    is supplied, the stored provider's key is reused so the edit dialog can
    re-probe without retyping a (masked) key. Explicit base_url/api_key win.
    Returns ``{ok, models, message}``.
    """
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can probe LLM providers")

    body = request.get_json(silent=True) or {}
    base_url = (body.get("base_url") or "").strip()
    api_key = body.get("api_key")
    pid = body.get("id")

    stored = llm_conf.get_provider(pid) if pid else None
    if not base_url and stored:
        base_url = stored.get("base_url") or ""
    if api_key is None and stored:
        api_key = stored.get("api_key") or ""
    if not base_url:
        raise bad_request("base_url is required")

    ok, models, message = _probe_models(base_url, api_key or "")
    audit.record("api_llm_provider_models", detail=base_url,
                 actor=current_username() or "unknown")
    return jsonify({"ok": ok, "models": models, "message": message})


@llm_bp.route("/providers/test", methods=["POST"])
@require_auth("dev.llm")
def llm_provider_test():
    """Probe a provider's OpenAI-compatible endpoint. Body: {id}.

    Validates the whole ordered ``models`` fallback list. Returns
    {ok, message, models?}. Never raises on upstream failure — connection
    problems are reported in `message`.
    """
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can test LLM providers")

    body = request.get_json(silent=True) or {}
    pid = body.get("id")
    if not pid:
        raise bad_request("id is required")

    p = llm_conf.get_provider(pid)
    if not p:
        raise not_found(f"Provider {pid} not found")

    base_url = (p.get("base_url") or "").strip()
    if not base_url:
        raise bad_request("Provider has no base_url")

    want = p.get("models") or ([p["model"]] if p.get("model") else [])
    ok, available, message = _probe_models(base_url, p.get("api_key") or "")
    if not ok:
        return jsonify({"ok": False, "message": message})
    if available:
        missing = [m for m in want if m not in available]
        if missing:
            return jsonify({"ok": True, "models": available,
                            "message": f"连接成功，但未找到模型 {', '.join(missing)}（共 {len(available)} 个可用）"})
        return jsonify({"ok": True, "models": available,
                        "message": f"连接成功，{len(available)} 个模型可用"})
    return jsonify({"ok": True, "models": available, "message": message})


@llm_bp.route("/usage", methods=["GET"])
@require_auth("dev.llm")
def llm_usage_stats():
    """LLM usage statistics.

    Query params:
      days - lookback period (default 7)
    """
    _uo = current_user_obj()
    is_admin = _uo.get("role") in ("super", "admin")

    try:
        days = min(90, max(1, int(request.args.get("days", 7))))
    except (ValueError, TypeError):
        days = 7

    summary = llm_usage.total_summary(days)
    daily_raw = llm_usage.day_summary(days)
    component_raw = llm_usage.component_summary(days)
    top = llm_usage.top_users(days) if is_admin else []
    recent = llm_usage.recent_calls(50) if is_admin else []

    if not is_admin:
        me = current_username() or ""
        my_usage = llm_usage.user_summary(me, days)
        summary = my_usage
        top = [{"user": me, **my_usage}] if my_usage.get("calls") else []
        recent = [c for c in llm_usage.recent_calls(50) if c.get("user") == me]

    # ── Transform to frontend-expected shape ──
    # Frontend reads usage.total_tokens / prompt_tokens / completion_tokens / total_cost
    # and daily=[{date,tokens}], component=[{component,tokens}], top_users=[{user,tokens,cost}]
    # Cost: nominal ¥0.004/1K prompt + ¥0.012/1K completion.
    # Configurable via env: YATTERRA_LLM_PROMPT_RATE / YATTERRA_LLM_COMP_RATE
    # (per-token rates; defaults match the original hardcoded values).
    PROMPT_RATE = float(os.environ.get("YATTERRA_LLM_PROMPT_RATE", "0.004") or 0.004) / 1000
    COMP_RATE = float(os.environ.get("YATTERRA_LLM_COMP_RATE", "0.012") or 0.012) / 1000

    def _cost(p, c):
        return round(p * PROMPT_RATE + c * COMP_RATE, 4)

    summary_out = {
        "total_tokens": summary.get("total", 0),
        "prompt_tokens": summary.get("prompt", 0),
        "completion_tokens": summary.get("completion", 0),
        "total_cost": _cost(summary.get("prompt", 0), summary.get("completion", 0)),
        "calls": summary.get("calls", 0),
    }

    # daily: {date: {user: bucket}} → [{date, tokens}]
    daily_out = []
    for date, users in daily_raw.items():
        day_total = sum(b.get("total", 0) for b in users.values())
        daily_out.append({"date": date, "tokens": day_total})
    daily_out.sort(key=lambda x: x["date"])

    # component: {date: {component: bucket}} → [{component, tokens}]
    comp_agg = {}
    for date, comps in component_raw.items():
        for comp, bucket in comps.items():
            comp_agg[comp] = comp_agg.get(comp, 0) + bucket.get("total", 0)
    component_out = [{"component": c, "tokens": t} for c, t in comp_agg.items()]
    component_out.sort(key=lambda x: -x["tokens"])

    # top_users: add tokens + cost aliases
    _labels = users.user_labels(
        [u.get("user") for u in top] + [c.get("user") for c in recent]
        + [current_username() or ""])
    top_out = []
    for u in top:
        uname = u.get("user", "?")
        top_out.append({
            "user": uname,
            "user_label": _labels.get(uname, uname),
            "tokens": u.get("total", 0),
            "total": u.get("total", 0),
            "prompt": u.get("prompt", 0),
            "completion": u.get("completion", 0),
            "cost": _cost(u.get("prompt", 0), u.get("completion", 0)),
            "calls": u.get("calls", 0),
        })
    for c in recent:
        uname = c.get("user")
        if uname:
            c["user_label"] = _labels.get(uname, uname)

    return jsonify({
        **summary_out,
        "summary": summary_out,
        "daily": daily_out,
        "component": component_out,
        "top_users": top_out,
        "recent": recent,
    })


@llm_bp.route("/quota", methods=["GET"])
@require_auth("dev.llm")
def llm_quota():
    """Current user's daily LLM token quota status.

    Returns ``{used_tokens_today, daily_limit, remaining, percent}``.
    ``daily_limit <= 0`` means the quota check is disabled; ``remaining``
    and ``percent`` are then null/0.
    """
    me = current_username() or ""
    ok, used, limit = llm_usage.check_quota(me)
    limit = limit or 0
    if limit > 0:
        remaining = max(limit - used, 0)
        percent = round(min(used / limit * 100.0, 100.0), 1)
    else:
        remaining = None
        percent = 0.0
    return jsonify({
        "used_tokens_today": used,
        "daily_limit": limit,
        "remaining": remaining,
        "percent": percent,
    })


@llm_bp.route("/metrics", methods=["GET"])
@require_auth("dev.llm")
def llm_metrics_endpoint():
    """LLM observability counters (requests/errors/fallbacks/latency). Admin only."""
    _uo = current_user_obj()
    if _uo.get("role") not in ("super", "admin"):
        raise forbidden("Only admins can view LLM metrics")
    return jsonify(metrics.llm_metrics())


@llm_bp.route("/usage/summary", methods=["GET"])
@require_auth("dev.llm")
def llm_usage_summary():
    """LLM usage summary — alias for /usage, for SPA compatibility."""
    return llm_usage_stats()
