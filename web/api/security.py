"""Security API blueprint — /api/security

平台安全巡检板（运维板块）后端：
  * 静态巡检：明文密钥 / 危险代码逻辑 / 集群配置（scan_svc）
  * 端到端渗透：驱动 ARTEX 自主渗透平台建任务、拉结果（artex_svc）

本蓝图**仅超级管理员(super)可用**：静态巡检结果含全平台明文密钥/危险代码，
渗透任务可对目标发起真实攻击，故整板按角色收口（@require_auth(min_role="super")），
不通过普通权限位下发。前端相应页面/入口也用 super-only 的 ops.scan.read 作标记。
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import Blueprint, request, jsonify

import audit
import groups
import scan_svc
import artex_svc

from api._auth import require_auth, current_username

log = logging.getLogger(__name__)

security_bp = Blueprint("api_security", __name__, url_prefix="/api/security")

# 全量巡检较重，串行化：同一时刻只允许一个手动 L1 巡检在跑。
_SCAN_LOCK = threading.Lock()

# 内网渗透目标：ARTEX 自身不扫，组的 web Service 端口恒为 8080（android 的
# targetPort 6080 由 kube-proxy 映射，URL 仍是 :8080 —— 见 groups.service_yaml）。
ARTEX_GROUP = "artex"
WEB_SVC_PORT = 8080
_TARGET_PROBE_TIMEOUT = 1.2  # 秒；判断 Pod 的 :8080 是否有服务在听


# ── 静态巡检 ────────────────────────────────────────────────────────────────
@security_bp.route("/overview", methods=["GET"])
@require_auth(min_role="super")
def scan_overview():
    """巡检总览：按等级计数 + 最近一次运行 + ARTEX 连通性。"""
    out = {"scan": scan_svc.summary(), "history": scan_svc.history(limit=10),
           "running": _SCAN_LOCK.locked()}
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
@require_auth(min_role="super")
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
        scope=request.args.get("scope") or None,
        category=request.args.get("category") or None,
        source=request.args.get("source") or None,
        limit=limit, offset=offset))


@security_bp.route("/scopes", methods=["GET"])
@require_auth(min_role="super")
def scan_scopes():
    """按 scope（Pod / platform / host）聚合，供前端「按 Pod 筛选」下拉。"""
    return jsonify({"scopes": scan_svc.scope_summary(),
                    "categories": scan_svc.category_summary(),
                    "labels": scan_svc.CATEGORIES})


@security_bp.route("/scans", methods=["GET"])
@require_auth(min_role="super")
def scan_kinds():
    """可跑的巡检层（code/files/k8s/host）。"""
    return jsonify({"kinds": [{"id": k, "label": v} for k, v in {
        "code": "代码/配置文本", "files": "文件/权限", "k8s": "集群清单", "host": "主机配置"
    }.items() if k in scan_svc.SCANS]})


@security_bp.route("/review/<pod>", methods=["POST"])
@require_auth(min_role="super")
def scan_review_pod(pod):
    """对单个 Pod 立即跑一次 podwatch 巡检（含 L2/L3 安全审查，force）。"""
    import re
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", pod or ""):
        return jsonify({"error": "非法 Pod 名"}), 400
    import podwatch
    res = podwatch.scan_one(pod, force=True)
    if res is None:
        return jsonify({"error": "该 Pod 无可扫描的 home 目录"}), 404
    audit.record("api_scan_review", detail=f"pod={pod} sec={bool(res.get('sec'))}",
                 actor=current_username() or "unknown")
    return jsonify({"ok": True, "result": res})


@security_bp.route("/scan", methods=["POST"])
@require_auth(min_role="super")
def scan_run():
    """立即跑一遍静态巡检。

    全量 L1 一轮约需数十秒；若**同步**跑，很容易撞上公网入口 nginx 的
    proxy_read_timeout(默认 60s) 被 504。故改为后台线程执行、接口立即返回
    `{started:true}`，前端弹提示后再刷新总览看结果。加锁避免并发重复跑。
    """
    import threading
    kinds = None
    body = request.get_json(silent=True) or {}
    if isinstance(body.get("kinds"), list):
        kinds = [k for k in body["kinds"] if k in scan_svc.SCANS] or None
    actor = current_username() or "unknown"
    if not _SCAN_LOCK.acquire(blocking=False):
        return jsonify({"ok": False, "started": False, "error": "已有巡检在跑，请稍候"}), 409

    def _bg():
        try:
            res = scan_svc.run_scan(kinds=kinds, trigger=f"manual:{actor}")
            audit.record("api_scan_run",
                         detail=f"total={res.get('total')} new={res.get('new')}",
                         actor=actor)
        except Exception:
            log.exception("manual scan failed")
        finally:
            _SCAN_LOCK.release()

    threading.Thread(target=_bg, name="scan-manual", daemon=True).start()
    audit.record("api_scan_start", detail=f"kinds={kinds or 'all'}", actor=actor)
    return jsonify({"ok": True, "started": True})


@security_bp.route("/findings/<fingerprint>/status", methods=["POST"])
@require_auth(min_role="super")
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


# ---- Pod → 内网 Service 渗透目标 -----------------------------------------
def _pod_web_up(cip):
    """ClusterIP:8080 是否真有 HTTP 服务在听（best-effort，绝不抛）。

    任何 HTTP 状态码（含 401/403）都算「在听」；连接被拒/超时/其它错误算「没在听」。
    """
    try:
        req = Request(f"http://{cip}:{WEB_SVC_PORT}/", method="GET")
        with urlopen(req, timeout=_TARGET_PROBE_TIMEOUT) as r:
            return 200 <= getattr(r, "status", 200) < 600
    except HTTPError as e:            # 有响应、只是状态非 2xx → 服务在
        return 200 <= e.code < 600
    except (URLError, OSError, ValueError):
        return False


def _resolve_group_target(name):
    """组名 → 内网渗透目标描述（只读）。

    用 Service ``group-<name>`` 的 **ClusterIP**（Service 生命周期内稳定，Pod 重建
    也不变），不是 podIP。返回 {ok,name,type,node,status,running,cluster_ip,internal_url}
    或 {ok:False,...,error}（组不存在 / 无 ClusterIP）。
    """
    state = groups.load_state().get("groups", {})
    rec = state.get(name)
    if not rec:
        return {"ok": False, "name": name, "error": "组不存在"}
    status = groups.pod_status(name)
    cip = groups.service_cluster_ip(name)
    base = {"name": name, "type": rec.get("type"), "node": rec.get("node"),
            "status": status, "running": status == "Running"}
    if not cip:
        base.update(ok=False, cluster_ip=None, internal_url=None,
                    error=f"Service group-{name} 未就绪（无 ClusterIP）")
        return base
    base.update(ok=True, cluster_ip=cip,
                internal_url=f"http://{cip}:{WEB_SVC_PORT}")
    return base


@security_bp.route("/artex", methods=["GET"])
@require_auth(min_role="super")
def artex_status():
    return _artex_guard(lambda: jsonify(artex_svc.status()))


@security_bp.route("/artex/tasks", methods=["GET"])
@require_auth(min_role="super")
def artex_tasks():
    return _artex_guard(lambda: jsonify(artex_svc.list_tasks()))


@security_bp.route("/artex/tasks", methods=["POST"])
@require_auth(min_role="super")
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


@security_bp.route("/artex/targets", methods=["GET"])
@require_auth(min_role="super")
def artex_targets():
    """可选的内网渗透目标 Pod 列表（含内网 URL），排除 ARTEX 自身。

    每项带 ``web_up``（:8080 是否真有服务在听）；``selectable`` 才允许发起。
    不可选者也列出，好让前端解释原因。
    """
    state = groups.load_state().get("groups", {})
    statuses = groups.all_pod_statuses()
    names = [n for n in sorted(state, key=lambda n: state[n].get("index", 0))
             if n != ARTEX_GROUP]
    # 解析每个组的 ClusterIP（kubectl），并并发探测其 :8080
    cips = {n: groups.service_cluster_ip(n) for n in names}
    probe = [n for n in names if cips.get(n)]
    up = {}
    if probe:
        with ThreadPoolExecutor(max_workers=min(16, len(probe))) as ex:
            for n, ok in zip(probe, ex.map(lambda x: _pod_web_up(cips[x]), probe)):
                up[n] = ok

    items = []
    for n in names:
        rec = state[n]
        status = statuses.get(n, "NotFound")
        cip = cips.get(n) or None
        running = status == "Running"
        web_up = bool(up.get(n))
        err = None
        if not cip:
            err = f"Service group-{n} 未就绪（无 ClusterIP）"
        elif not running:
            err = f"Pod 未运行（{status}）"
        elif not web_up:
            err = "该 Pod 的 :8080 无服务响应"
        items.append({
            "name": n, "type": rec.get("type"), "node": rec.get("node"),
            "internal": bool(rec.get("internal")),
            "status": status, "running": running,
            "cluster_ip": cip,
            "internal_url": f"http://{cip}:{WEB_SVC_PORT}" if cip else None,
            "web_up": web_up,
            "selectable": bool(cip) and running and web_up,
            "error": err,
        })
    return jsonify({"targets": items})


@security_bp.route("/artex/pod-scan", methods=["POST"])
@require_auth(min_role="super")
def artex_pod_scan():
    """对选中 Pod 的内网 Service 发起 ARTEX 渗透。body: {pod, goal?}"""
    body = request.get_json(silent=True) or {}
    pod = str(body.get("pod") or "").strip()
    if not pod:
        return jsonify({"error": "pod 不能为空"}), 400
    if pod == ARTEX_GROUP:
        return jsonify({"error": "不能对 ARTEX 自身发起渗透"}), 400

    tgt = _resolve_group_target(pod)
    if not tgt.get("ok"):
        code = 404 if tgt.get("error") == "组不存在" else 409
        return jsonify({"error": tgt.get("error")}), code
    if not tgt["running"]:
        return jsonify({"error": f"Pod {pod} 未运行（{tgt['status']}）"}), 409
    if not _pod_web_up(tgt["cluster_ip"]):
        return jsonify({"error": f"Pod {pod} 的 :{WEB_SVC_PORT} 无服务响应"}), 409

    def _do():
        res = artex_svc.create_pod_scan(
            pod, tgt["cluster_ip"], port=WEB_SVC_PORT,
            goal=str(body.get("goal") or ""),
            reason=f"pod-internal:{pod}")
        audit.record("api_artex_pod_scan",
                     detail=f"pod={pod} target={tgt['internal_url']}",
                     actor=current_username() or "unknown")
        return jsonify({"ok": True, "target": tgt["internal_url"], **res})
    return _artex_guard(_do)


@security_bp.route("/artex/tasks/<task_id>/control", methods=["POST"])
@require_auth(min_role="super")
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
@require_auth(min_role="super")
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
@require_auth(min_role="super")
def artex_findings_stats():
    return _artex_guard(lambda: jsonify(artex_svc.findings_stats()))


@security_bp.route("/artex/findings/<fid>", methods=["GET"])
@require_auth(min_role="super")
def artex_finding_detail(fid):
    return _artex_guard(lambda: jsonify(artex_svc.finding_detail(fid)))
