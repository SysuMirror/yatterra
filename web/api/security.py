"""Security API blueprint — /api/security

平台安全巡检板（运维板块）后端：
  * 静态巡检：明文密钥 / 危险代码逻辑 / 集群配置（scan_svc）
  * 端到端渗透：驱动 ARTEX 自主渗透平台建任务、拉结果（artex_svc）

只读端点要求 ops.scan.read；产生副作用的（跑扫描、建任务、控制任务）要求
ops.scan.run（写隐含读，见 users._WRITE_IMPLIES_READ）。
"""
import logging

from flask import Blueprint, request, jsonify

import audit
import scan_svc
import artex_svc

from api._auth import require_auth, current_username

log = logging.getLogger(__name__)

security_bp = Blueprint("api_security", __name__, url_prefix="/api/security")


# ── 静态巡检 ────────────────────────────────────────────────────────────────
@security_bp.route("/overview", methods=["GET"])
@require_auth("ops.scan.read")
def scan_overview():
    """巡检总览：按等级计数 + 最近一次运行 + ARTEX 连通性。"""
    out = {"scan": scan_svc.summary(), "history": scan_svc.history(limit=10)}
    try:
        st = artex_svc.status()
        out["artex"] = {
            "ok": st.get("ok", False), "reachable": st.get("reachable", False),
            "version": st.get("version"), "url": st.get("url"),
            "tasks": len(st.get("tasks", []) or []),
            "active": st.get("active"), "error": st.get("error"),
        }
    except Exception as e:  # artex_svc 一般返回结构体，这里兜底
        out["artex"] = {"ok": False, "error": str(e)}
    return jsonify(out)


@security_bp.route("/findings", methods=["GET"])
@require_auth("ops.scan.read")
def scan_findings():
    """静态巡检结果（分页 + 过滤）。"""
    try:
        limit = min(500, max(1, int(request.args.get("limit", 200))))
        offset = max(0, int(request.args.get("offset", 0)))
    except (ValueError, TypeError):
        limit, offset = 200, 0
    return jsonify(scan_svc.list_findings(
        severity=request.args.get("severity") or None,
        check=request.args.get("check") or None,
        q=request.args.get("q") or None,
        status=request.args.get("status") or None,
        limit=limit, offset=offset))


@security_bp.route("/scan", methods=["POST"])
@require_auth("ops.scan.run")
def scan_run():
    """立即跑一遍静态巡检。"""
    kinds = None
    body = request.get_json(silent=True) or {}
    if isinstance(body.get("kinds"), list):
        kinds = [k for k in body["kinds"] if k in scan_svc.SCANS] or None
    res = scan_svc.run_scan(kinds=kinds, trigger=f"manual:{current_username() or 'api'}")
    audit.record("api_scan_run", detail=f"total={res.get('total')} new={res.get('new')}",
                 actor=current_username() or "unknown")
    code = 200 if res.get("ok") else 500
    return jsonify(res), code


@security_bp.route("/findings/<fingerprint>/status", methods=["POST"])
@require_auth("ops.scan.run")
def scan_finding_status(fingerprint):
    """标记某条巡检结果为 ignored/resolved/open。"""
    body = request.get_json(silent=True) or {}
    status = str(body.get("status") or "")
    try:
        scan_svc.set_status(fingerprint, status)
    except ValueError:
        return jsonify({"error": "status 只能是 open/ignored/resolved"}), 400
    audit.record("api_scan_finding_status", detail=f"{fingerprint}→{status}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True})


# ── ARTEX 端到端渗透 ────────────────────────────────────────────────────────
def _artex_guard(fn):
    """把 ArtexError 收敛成 502。"""
    try:
        return fn()
    except artex_svc.ArtexError as e:
        return jsonify({"error": str(e)}), 502


@security_bp.route("/artex", methods=["GET"])
@require_auth("ops.scan.read")
def artex_status():
    return _artex_guard(lambda: jsonify(artex_svc.status()))


@security_bp.route("/artex/tasks", methods=["GET"])
@require_auth("ops.scan.read")
def artex_tasks():
    return _artex_guard(lambda: jsonify(artex_svc.list_tasks()))


@security_bp.route("/artex/tasks", methods=["POST"])
@require_auth("ops.scan.run")
def artex_create_task():
    """建一个端到端渗透任务。body: {description, goal?, name?, category_id?}"""
    body = request.get_json(silent=True) or {}
    desc = str(body.get("description") or "").strip()
    if not desc:
        return jsonify({"error": "description 不能为空"}), 400

    def _do():
        t = artex_svc.create_task(
            desc, goal=str(body.get("goal") or ""),
            name=(str(body.get("name")).strip() or None) if body.get("name") else None,
            category_id=body.get("category_id"))
        audit.record("api_artex_task", detail=f"desc={desc[:80]}",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "task": t})
    return _artex_guard(_do)


@security_bp.route("/artex/tasks/<task_id>/control", methods=["POST"])
@require_auth("ops.scan.run")
def artex_control_task(task_id):
    body = request.get_json(silent=True) or {}
    action = str(body.get("action") or "")
    if action not in ("pause", "resume"):
        return jsonify({"error": "action 只能是 pause/resume"}), 400
    def _do():
        r = artex_svc.control_task(task_id, action)
        audit.record("api_artex_control", detail=f"task={task_id} {action}",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "result": r})
    return _artex_guard(_do)


@security_bp.route("/artex/findings", methods=["GET"])
@require_auth("ops.scan.read")
def artex_findings():
    """代理 ARTEX 漏洞结果（分页 + 按任务/等级/状态过滤）。"""
    try:
        page = max(1, int(request.args.get("page", 1)))
        limit = min(200, max(1, int(request.args.get("limit", 50))))
    except (ValueError, TypeError):
        page, limit = 1, 50
    return _artex_guard(lambda: jsonify(artex_svc.list_findings(
        task=request.args.get("task") or None,
        severity=request.args.get("severity") or None,
        status=request.args.get("status") or None,
        q=request.args.get("q") or None,
        page=page, limit=limit)))


@security_bp.route("/artex/stats", methods=["GET"])
@require_auth("ops.scan.read")
def artex_findings_stats():
    return _artex_guard(lambda: jsonify(artex_svc.findings_stats()))


@security_bp.route("/artex/findings/<fid>", methods=["GET"])
@require_auth("ops.scan.read")
def artex_finding_detail(fid):
    return _artex_guard(lambda: jsonify(artex_svc.finding_detail(fid)))
