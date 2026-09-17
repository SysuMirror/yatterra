"""MCP (Model Context Protocol) API blueprint — /api/mcp

MCP server CRUD and toggle.
"""
from flask import Blueprint, request, jsonify, g
from middleware.error_handler import ApiError, bad_request, not_found

import mcp_client
import audit

from api._auth import require_auth, current_username

mcp_bp = Blueprint("api_mcp", __name__, url_prefix="/api/mcp")


@mcp_bp.route("", methods=["GET"])
@require_auth("dev.mcp")
def mcp_list():
    """List all MCP servers."""
    servers = mcp_client.load_servers()
    return jsonify({"servers": servers})


@mcp_bp.route("", methods=["POST"])
@require_auth("dev.mcp")
def mcp_add():
    """Add a new MCP server."""
    body = request.get_json(silent=True) or {}
    srv = {
        "name": (body.get("name") or "").strip(),
        "transport": body.get("transport", "stdio"),
        "enabled": bool(body.get("enabled", True)),
        "command": body.get("command") or [],
        "url": body.get("url") or "",
        "env": body.get("env") or {},
        "headers": body.get("headers") or {},
        "init_timeout": body.get("init_timeout", 60),
        "call_timeout": body.get("call_timeout", 60),
    }
    if not srv["name"]:
        raise bad_request("Server name is required")
    if srv["transport"] == "stdio" and not srv["command"]:
        raise bad_request("stdio transport requires a command")
    if srv["transport"] == "http" and not srv["url"]:
        raise bad_request("http transport requires a url")

    servers = mcp_client.load_servers()
    # Check for duplicate name
    if any(s["name"] == srv["name"] for s in servers):
        raise bad_request(f"Server '{srv['name']}' already exists")

    servers.append(srv)
    try:
        mcp_client.save_servers(servers)
        audit.record("api_mcp_add", detail=srv["name"], actor=current_username() or "unknown")
        return jsonify({"ok": True, "server": srv}), 201
    except Exception as e:
        raise bad_request(str(e))


@mcp_bp.route("/<server_id>", methods=["PUT"])
@require_auth("dev.mcp")
def mcp_update(server_id):
    """Update an existing MCP server."""
    body = request.get_json(silent=True) or {}
    servers = mcp_client.load_servers()
    found = None
    for s in servers:
        if s["name"] == server_id:
            found = s
            break
    if not found:
        raise not_found(f"MCP server '{server_id}' not found")

    # Apply updates
    for k in ("transport", "command", "url", "env", "headers", "init_timeout", "call_timeout"):
        if k in body:
            found[k] = body[k]
    if "enabled" in body:
        found["enabled"] = bool(body["enabled"])
    if "name" in body:
        new_name = (body["name"] or "").strip()
        if new_name:
            found["name"] = new_name

    try:
        mcp_client.save_servers(servers)
        audit.record("api_mcp_update", detail=server_id, actor=current_username() or "unknown")
        return jsonify({"ok": True, "server": found})
    except Exception as e:
        raise bad_request(str(e))


@mcp_bp.route("/<server_id>", methods=["DELETE"])
@require_auth("dev.mcp")
def mcp_delete(server_id):
    """Delete an MCP server."""
    servers = mcp_client.load_servers()
    new_servers = [s for s in servers if s["name"] != server_id]
    if len(new_servers) == len(servers):
        raise not_found(f"MCP server '{server_id}' not found")
    mcp_client.save_servers(new_servers)
    audit.record("api_mcp_delete", detail=server_id, actor=current_username() or "unknown")
    return jsonify({"ok": True})


@mcp_bp.route("/catalog", methods=["GET"])
@require_auth("dev.mcp")
def mcp_catalog():
    """MCP catalog — alias for list, for SPA compatibility."""
    servers = mcp_client.load_servers()
    return jsonify({"servers": servers})


@mcp_bp.route("/<server_id>/toggle", methods=["POST"])
@require_auth("dev.mcp")
def mcp_toggle(server_id):
    """Toggle an MCP server on/off."""
    servers = mcp_client.load_servers()
    found = False
    for s in servers:
        if s["name"] == server_id:
            s["enabled"] = not s["enabled"]
            found = True
            break
    if not found:
        raise not_found(f"MCP server '{server_id}' not found")
    mcp_client.save_servers(servers)
    audit.record("api_mcp_toggle", detail=server_id, actor=current_username() or "unknown")
    return jsonify({"ok": True})
