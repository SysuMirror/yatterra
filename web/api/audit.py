"""Audit API blueprint — /api/audit

Audit log entries with filtering.
"""
from flask import Blueprint, request, jsonify

import audit as audit_mod
import users as users_mod

from api._auth import require_auth

audit_bp = Blueprint("api_audit", __name__, url_prefix="/api/audit")


@audit_bp.route("", methods=["GET"])
@require_auth("ops.audit")
def audit_list():
    """List audit entries with optional filters and real pagination.

    Query params:
      page     - 1-based page number (default 1)
      per_page - page size (default 100, max 1000)
      limit    - legacy alias for per_page (ignored when per_page is given)
      actor    - filter by actor
      action   - filter by action type
      since    - ISO timestamp lower bound
      until    - ISO timestamp upper bound

    ``total`` is the real number of entries matching the filters, so the
    frontend can compute the last page.
    """
    try:
        per_page = min(1000, max(1, int(request.args.get("per_page", 0) or 0)))
    except (ValueError, TypeError):
        per_page = 0
    if not per_page:
        try:
            per_page = min(1000, max(1, int(request.args.get("limit", 100))))
        except (ValueError, TypeError):
            per_page = 100
    try:
        page = max(1, int(request.args.get("page", 1)))
    except (ValueError, TypeError):
        page = 1

    actor = (request.args.get("actor") or "").strip()
    action = (request.args.get("action") or "").strip()
    since = (request.args.get("since") or "").strip()
    until = (request.args.get("until") or "").strip()

    entries, total = audit_mod.audit_query(
        limit=per_page, offset=(page - 1) * per_page,
        actor=actor or None, action=action or None,
        since=since or None, until=until or None,
    )

    # Resolve actor usernames (sse_*) to "昵称(sse_序号)" for display. System
    # actors (module=...) simply won't resolve and keep their raw name.
    labels = users_mod.user_labels([e.get("actor") for e in entries])
    for e in entries:
        actor = e.get("actor")
        if actor:
            e["actor_label"] = labels.get(actor, actor)

    return jsonify({
        "entries": entries,
        "total": total,
        "page": page,
        "per_page": per_page,
    })
