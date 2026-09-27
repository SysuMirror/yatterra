"""Audit API blueprint — /api/audit

Audit log entries with filtering.
"""
from flask import Blueprint, request, jsonify
from middleware.error_handler import bad_request

import audit as audit_mod
import users as users_mod

from api._auth import require_auth

audit_bp = Blueprint("api_audit", __name__, url_prefix="/api/audit")


@audit_bp.route("", methods=["GET"])
@require_auth("ops.audit")
def audit_list():
    """List audit entries with optional filters.

    Query params:
      limit   - max entries (default 100, max 1000)
      actor   - filter by actor
      action  - filter by action type
      since   - ISO timestamp lower bound
      until   - ISO timestamp upper bound
    """
    try:
        limit = min(1000, max(1, int(request.args.get("limit", 100))))
    except (ValueError, TypeError):
        limit = 100

    actor = (request.args.get("actor") or "").strip()
    action = (request.args.get("action") or "").strip()
    since = (request.args.get("since") or "").strip()
    until = (request.args.get("until") or "").strip()

    entries = audit_mod.audit_entries(limit=limit * 5)  # fetch extra for filtering

    # Apply filters
    if actor:
        entries = [e for e in entries if e.get("actor") == actor]
    if action:
        entries = [e for e in entries if action in (e.get("action") or "")]
    if since:
        entries = [e for e in entries if e.get("ts", "") >= since]
    if until:
        entries = [e for e in entries if e.get("ts", "") <= until]

    # Trim to requested limit after filtering
    entries = entries[:limit]

    # Resolve actor usernames (sse_*) to "昵称(sse_序号)" for display. System
    # actors (module=...) simply won't resolve and keep their raw name.
    labels = users_mod.user_labels([e.get("actor") for e in entries])
    for e in entries:
        actor = e.get("actor")
        if actor:
            e["actor_label"] = labels.get(actor, actor)

    return jsonify({"entries": entries, "total": len(entries)})
