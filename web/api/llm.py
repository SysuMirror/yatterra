"""LLM API blueprint — /api/llm

LLM provider management and usage statistics.
"""
from flask import Blueprint, request, jsonify, g, session
from middleware.error_handler import ApiError, bad_request, not_found, forbidden

import llm_conf
import llm_usage
import audit

from api._auth import require_auth, current_username, current_user_obj

llm_bp = Blueprint("api_llm", __name__, url_prefix="/api/llm")


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
    # Cost: nominal ¥0.004/1K prompt + ¥0.012/1K completion (adjustable)
    PROMPT_RATE = 0.004 / 1000
    COMP_RATE = 0.012 / 1000

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
    top_out = []
    for u in top:
        top_out.append({
            "user": u.get("user", "?"),
            "tokens": u.get("total", 0),
            "total": u.get("total", 0),
            "prompt": u.get("prompt", 0),
            "completion": u.get("completion", 0),
            "cost": _cost(u.get("prompt", 0), u.get("completion", 0)),
            "calls": u.get("calls", 0),
        })

    return jsonify({
        **summary_out,
        "summary": summary_out,
        "daily": daily_out,
        "component": component_out,
        "top_users": top_out,
        "recent": recent,
    })


@llm_bp.route("/usage/summary", methods=["GET"])
@require_auth("dev.llm")
def llm_usage_summary():
    """LLM usage summary — alias for /usage, for SPA compatibility."""
    return llm_usage_stats()
