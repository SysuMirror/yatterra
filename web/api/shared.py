"""Shared directory API blueprint — /api/shared

File browser, file read, mkdir, upload, delete, download for the shared weights directory.
"""
import os
from flask import Blueprint, request, jsonify, Response
from middleware.error_handler import bad_request, not_found

import shared as shared_mod
import audit

from api._auth import require_auth, current_username

shared_bp = Blueprint("api_shared", __name__, url_prefix="/api/shared")


@shared_bp.route("", methods=["GET"])
@require_auth("ops.shared.read")
def shared_list():
    """List directory OR read file content.

    Query params:
      path - subdirectory path or file path (default: root)
    Returns:
      - For directories: {entries, current}
      - For text files: raw text content (text/plain)
      - For binary files: {error, is_binary, size}
    """
    path = request.args.get("path", "")
    # If it's a file, return content
    try:
        abs_path = shared_mod._abs(path)
    except ValueError as e:
        raise bad_request(str(e))
    if os.path.isfile(abs_path):
        try:
            content, is_binary, size = shared_mod.read_file(path)
        except ValueError as e:
            raise bad_request(str(e))
        if is_binary:
            return jsonify({"error": "binary", "is_binary": True, "size": size})
        # Return as plain text for the CodeEditor
        r = Response(content, mimetype="text/plain; charset=utf-8")
        return r
    # Otherwise list directory
    try:
        entries, cur = shared_mod.list_dir(path)
    except ValueError as e:
        raise bad_request(str(e))
    return jsonify({"entries": entries, "current": cur})


@shared_bp.route("/download", methods=["GET"])
@require_auth("ops.shared.read")
def shared_download():
    """Download a file from shared storage."""
    path = request.args.get("path", "")
    if not path:
        raise bad_request("Path is required")
    try:
        abs_path, filename = shared_mod.download_path(path)
    except ValueError as e:
        raise bad_request(str(e))
    with open(abs_path, "rb") as f:
        data = f.read()
    r = Response(data, mimetype="application/octet-stream")
    r.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return r


@shared_bp.route("/mkdir", methods=["POST"])
@require_auth("ops.shared.write")
def shared_mkdir():
    """Create a directory in shared storage.

    Body: {path, name}
    """
    body = request.get_json(silent=True) or {}
    path = body.get("path", "")
    name = body.get("name", "")
    if not name:
        raise bad_request("Directory name is required")
    try:
        rel = shared_mod.mkdir(path, name)
        audit.record("api_shared_mkdir", detail=rel, actor=current_username() or "unknown")
        return jsonify({"ok": True, "path": rel})
    except ValueError as e:
        raise bad_request(str(e))


@shared_bp.route("/upload", methods=["POST"])
@require_auth("ops.shared.write")
def shared_upload():
    """Upload a file to shared storage.

    Form data: file, path
    """
    f = request.files.get("file")
    path = request.form.get("path", "")
    if not f:
        raise bad_request("No file provided")
    try:
        rel = shared_mod.save_upload(path, f)
        audit.record("api_shared_upload", detail=f"{rel} ({f.filename})",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "path": rel, "filename": f.filename})
    except ValueError as e:
        raise bad_request(str(e))


@shared_bp.route("", methods=["DELETE"])
@require_auth("ops.shared.write")
def shared_delete():
    """Delete a file or directory in shared storage.

    Body: {path}
    """
    body = request.get_json(silent=True) or {}
    path = body.get("path", "")
    if not path:
        raise bad_request("Path is required")
    try:
        shared_mod.delete(path)
        audit.record("api_shared_delete", detail=path, actor=current_username() or "unknown")
        return jsonify({"ok": True, "path": path})
    except ValueError as e:
        raise bad_request(str(e))
