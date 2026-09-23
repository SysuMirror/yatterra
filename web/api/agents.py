"""Agents API blueprint — /api/agents

Agent listing, execution, streaming, session management.
"""
import secrets, json, time
from importlib import import_module
from flask import Blueprint, request, jsonify, Response, g
from middleware.error_handler import ApiError, not_found, bad_request

import agent
import agent_runs
import agent_conf
import browser_assistant
users = import_module("users")
import groups
import audit

from api._auth import require_auth, current_username, current_user_obj

agents_bp = Blueprint("api_agents", __name__, url_prefix="/api/agents")


@agents_bp.route("", methods=["GET"])
@require_auth()
def agents_list():
    """List agents visible to the current user."""
    _uo = current_user_obj()
    out = []
    for a in agent_conf.load_agents():
        req_perm = agent.agent_required_perm(a)
        if not users.has_perm(_uo, req_perm):
            continue
        out.append({
            "id": a["id"],
            "label": a["label"],
            "icon": a.get("icon", "🤖"),
            "runner": a["runner"],
        })
    return jsonify({"agents": out})


@agents_bp.route("/<agent_id>", methods=["GET"])
@require_auth()
def agents_get(agent_id):
    """Get a single agent definition."""
    adef = agent_conf.get_agent(agent_id)
    if not adef:
        raise not_found(f"Agent {agent_id} not found")
    _uo = current_user_obj()
    req_perm = agent.agent_required_perm(adef)
    if not users.has_perm(_uo, req_perm):
        raise ApiError("FORBIDDEN", "Permission denied for this agent", 403)
    return jsonify({"agent": adef})


@agents_bp.route("/<agent_id>", methods=["PUT"])
@require_auth("dev.agent")
def agents_update(agent_id):
    """Update an agent definition."""
    body = request.get_json(silent=True) or {}
    agents_list_data = agent_conf.load_agents()
    found = False
    for a in agents_list_data:
        if a["id"] == agent_id:
            # Merge updates
            for k, v in body.items():
                if k != "id":
                    a[k] = v
            found = True
            break
    if not found:
        raise not_found(f"Agent {agent_id} not found")
    agent_conf.save_agents(agents_list_data)
    audit.record("api_agent_update", detail=agent_id, actor=current_username() or "unknown")
    return jsonify({"ok": True})


@agents_bp.route("/run", methods=["POST"])
@require_auth()
def agents_run():
    """Start a persistent background agent run.

    Body: {mode, name?, message, session_id?}
    Returns: {run_id}
    """
    body = request.get_json(silent=True) or {}
    mode = body.get("mode", "ops")
    name = body.get("name")
    message = (body.get("message") or "").strip()
    _uo = current_user_obj()
    _cu = current_username()

    _valid_ids = {a["id"] for a in agent_conf.load_agents()}
    if mode not in _valid_ids:
        raise bad_request(f"Unknown agent: {mode}")

    # Mode-level permission check
    adef = agent_conf.get_agent(mode)
    req_perm = agent.agent_required_perm(adef)
    if not users.has_perm(_uo, req_perm):
        raise ApiError("FORBIDDEN", "Permission denied for this agent", 403)

    # Build mode: check pod access
    if adef and adef.get("runner") == "pod":
        state = groups.load_state()
        pod_dict = state["groups"].get(name, {})
        if not users.can_pod(_uo, pod_dict, "member"):
            raise ApiError("FORBIDDEN", f"Access denied for Pod {name}", 403)

    if not message:
        raise bad_request("Message is required")

    session_id = body.get("session_id")
    run_id = secrets.token_hex(8)
    if session_id:
        history = agent_runs.load_session_history(session_id, _cu)
    else:
        history = agent_runs.load_history(mode, name, _cu)
    agent_runs.start(mode, name, message, history, run_id, session_id,
                     user=_uo, username=_cu)
    return jsonify({"run_id": run_id})


@agents_bp.route("/stream", methods=["GET"])
@require_auth()
def agents_stream():
    """SSE stream for an agent run.

    Query params: run_id, offset
    Header: Last-Event-ID for resumption.
    """
    run_id = request.args.get("run_id", "")
    lei = request.headers.get("Last-Event-ID")
    try:
        if lei is not None:
            after = int(lei) + 1
        else:
            after = int(request.args.get("offset") or 0)
    except ValueError:
        after = 0

    run = agent_runs.get(run_id)
    if not run:
        raise not_found("Run not found or has ended")
    # Only the run's owner (or super/admin) may stream its output —
    # agent runs can contain infra/ops details from the owner's context.
    _uo = current_user_obj()
    if run.username and run.username != current_username() \
            and _uo.get("role") not in ("super", "admin"):
        raise ApiError("FORBIDDEN", "Access denied for this run", 403)

    def stream():
        yield "retry: 5000\n\n"
        for item in agent_runs.stream_events(run_id, after):
            if item is None:
                yield ": keepalive\n\n"
            else:
                idx, ev = item
                yield f"id: {idx}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"

    resp = Response(stream(), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp


@agents_bp.route("/stop", methods=["POST"])
@require_auth()
def agents_stop():
    """Stop a running agent (own runs only; super/admin may stop any)."""
    body = request.get_json(silent=True) or {}
    run_id = body.get("run_id", "")
    run = agent_runs.get(run_id)
    if run:
        _uo = current_user_obj()
        if run.username and run.username != current_username() \
                and _uo.get("role") not in ("super", "admin"):
            raise ApiError("FORBIDDEN", "Access denied for this run", 403)
    agent.stop(run_id)
    return jsonify({"ok": True})


@agents_bp.route("/sessions", methods=["GET"])
@require_auth()
def agents_sessions():
    """List agent sessions for the current user."""
    mode = request.args.get("mode", "ops")
    return jsonify({"sessions": agent_runs.list_sessions(mode, current_username())})


@agents_bp.route("/session/new", methods=["POST"])
@require_auth()
def agents_session_new():
    """Create a new agent session."""
    body = request.get_json(silent=True) or {}
    mode = body.get("mode", "ops")
    _valid_ids = {a["id"] for a in agent_conf.load_agents()}
    if mode not in _valid_ids:
        raise bad_request(f"Unknown agent: {mode}")
    sid = agent_runs.create_session(mode, current_username())
    return jsonify({"session_id": sid})


@agents_bp.route("/session/load", methods=["GET"])
@require_auth()
def agents_session_load():
    """Load an agent session."""
    sid = request.args.get("id", "")
    s = agent_runs.get_session(sid, current_username())
    if not s:
        raise not_found("Session not found")
    return jsonify({
        "turns": s.get("turns", []),
        "mode": s.get("mode"),
        "title": s.get("title", "New conversation"),
    })


@agents_bp.route("/session/delete", methods=["DELETE", "POST"])
@require_auth()
def agents_session_delete():
    """Delete an agent session."""
    body = request.get_json(silent=True) or {}
    agent_runs.delete_session(body.get("id", ""), current_username())
    return jsonify({"ok": True})


@agents_bp.route("/session/rename", methods=["POST"])
@require_auth()
def agents_session_rename():
    """Rename an agent session."""
    body = request.get_json(silent=True) or {}
    sid = body.get("id", "")
    title = (body.get("title") or "").strip()
    if not sid:
        raise bad_request("id is required")
    agent_runs.rename_session(sid, title, current_username())
    return jsonify({"ok": True})


@agents_bp.route("/browser/run", methods=["POST"])
@require_auth()
def browser_run():
    """Start universal browser assistant; it emits proposals only."""
    body = request.get_json(silent=True) or {}
    try:
        sid, run_id = browser_assistant.start(
            current_username(), body.get("session_id", ""), body.get("message", ""),
            body.get("page", ""), body.get("context", ""), body.get("receipt"))
    except ValueError as exc:
        raise bad_request(str(exc))
    except LookupError:
        raise not_found("Browser assistant session not found")
    return jsonify({"session_id": sid, "run_id": run_id})


@agents_bp.route("/browser/stream", methods=["GET"])
@require_auth()
def browser_stream():
    run_id = request.args.get("run_id", "")
    last = request.headers.get("Last-Event-ID")
    try:
        after = int(last) + 1 if last is not None else int(request.args.get("offset", "0"))
    except (TypeError, ValueError):
        after = 0
    username = current_username()
    if not browser_assistant.get_run(run_id, username):
        raise not_found("Browser assistant run not found")
    def stream():
        yield "retry: 5000\n\n"
        for item in browser_assistant.stream(run_id, username, after):
            if item is None:
                yield ": keepalive\n\n"
            else:
                idx, event = item
                yield f"id: {idx}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
    response = Response(stream(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@agents_bp.route("/browser/stop", methods=["POST"])
@require_auth()
def browser_stop():
    body = request.get_json(silent=True) or {}
    if not browser_assistant.stop(body.get("run_id", ""), current_username()):
        raise not_found("Browser assistant run not found")
    return jsonify({"ok": True})


@agents_bp.route("/browser/sessions", methods=["GET"])
@require_auth()
def browser_sessions():
    return jsonify({"sessions": browser_assistant.list_sessions(current_username())})


@agents_bp.route("/browser/session/new", methods=["POST"])
@require_auth()
def browser_session_new():
    sid = browser_assistant._new_session(current_username())
    return jsonify({"session_id": sid})


@agents_bp.route("/browser/session/load", methods=["GET"])
@require_auth()
def browser_session_load():
    sid = request.args.get("id", "")
    data = browser_assistant.get_session(sid, current_username())
    if not data:
        raise not_found("Browser assistant session not found")
    return jsonify({"turns": data.get("turns", []), "title": data.get("title", "New conversation")})


@agents_bp.route("/browser/session/delete", methods=["POST", "DELETE"])
@require_auth()
def browser_session_delete():
    body = request.get_json(silent=True) or {}
    if not browser_assistant.delete_session(body.get("id", ""), current_username()):
        raise not_found("Browser assistant session not found")
    return jsonify({"ok": True})


@agents_bp.route("/stats", methods=["GET"])
@require_auth("dev.agent")
def agents_stats():
    """Get agent runtime stats."""
    return jsonify(agent.stats())


@agents_bp.route("/pods", methods=["GET"])
@require_auth()
def agents_pods():
    """List pods accessible to the current user (for build mode pod selector)."""
    _uo = current_user_obj()
    state = groups.load_state()
    out = []
    for name, g in state["groups"].items():
        if users.can_pod(_uo, g, "member"):
            out.append({
                "name": name,
                "status": groups.pod_status(name),
                "role": users.pod_role(_uo, g),
            })
    return jsonify({"pods": out})
