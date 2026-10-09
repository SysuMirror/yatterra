"""AI 写动作的审批闸 + 事后核验闭环(最小可用)。

背景:ops agent(宿主机 root)会直接执行写操作,先前唯一的闸是可被绕过的正则
denylist,既没有 dry-run 也没有审批队列。本模块提供一个"需确认的写动作"登记 +
审批 + 事后核验的小闭环,默认只拦**高危写动作**,不打断现有只读巡检/自动化。

设计要点:
  - 分类:classify() 决定一个 tool 调用是否属"需确认的写动作"。
    * run / run_remote 命令命中高危写模式(rm/rmdir/mv/chmod/chown/dd/truncate/
      supervisorctl restart|stop|start、systemctl restart|stop|start|...、
      kubectl delete|scale|apply|patch|...、docker compose down|up|restart|...、
      > 覆盖重定向 等)
    * write_file / edit_file 覆盖非 /tmp 路径(宿主机 runner)
    pod runner(容器内 cloud 自己的环境/build 编程 agent)默认不拦,避免打断。
  - 挂起:gate() 命中时**不执行**,登记一条 pending 记录(内存 + 落盘 JSON),
    返回"已挂起,等待确认(approval id=...)"。
  - 审批:HTTP 端点(/api/agents/approve、/reject,见文件末尾蓝图)由
    admin+/infra.host 权限者批准后执行(agent._resume_approved),拒绝则作废。
  - 核验:approve 执行成功后会登记一条**只读**核验命令(如"重启 X"→
    "systemctl is-active X"、"kubectl delete/scale"→"kubectl get ..."
    、"write_file"→"ls -l path"),在下次同类操作或 run_agent 启动时执行,
    结果写入 audit 与 agent_memory。只核验"已接管的写动作",读操作不核验。

开关(env,读取时生效,无需重启):
  YATTERRA_APPROVAL_MODE = off | high(默认) | all
    off  : 关闭审批闸(完全恢复旧行为)
    high : 仅高危写动作需确认(默认,保持只读巡检流畅)
    all  : 所有非只读动作都需确认(激进,慎用)
  YATTERRA_APPROVALS_FILE = 记录文件路径(默认 <ROOT>/approvals.json)

本模块不 import agent(避免循环依赖);所有对 agent 的调用都在函数内惰性 import。
"""
import json
import os
import re
import threading
import time
from datetime import datetime

import siteconf

# --- 配置 ---
_FILE = os.environ.get("YATTERRA_APPROVALS_FILE") or siteconf.path("approvals.json")
_MAX_ITEMS = 200          # 落盘记录上限(超出淘汰最旧的已决记录)
_LOCK = threading.RLock()

_readonly = False  # 供测试/降级:置 True 时 gate() 永不挂起


def mode():
    """当前审批模式:off / high / all。默认 high。"""
    try:
        m = (os.environ.get("YATTERRA_APPROVAL_MODE") or "high").strip().lower()
    except Exception:
        m = "high"
    return m if m in ("off", "high", "all") else "high"


# --- 需确认的写动作分类 ---
# 高危写命令模式(用于 run / run_remote 的命令串)。只读子命令(status/describe/
# get/logs/df/du/journalctl/ps/free 等)不匹配这里,保持现有巡检流畅。
_WRITE_CMD_RE = re.compile(
    r"""(?ix)
    (?:
        \brmdir\b | \brm\b |
        \bmv\b |
        \bchmod\b | \bchown\b |
        \bdd\b |
        \btruncate\b |
        \bsupervisorctl\s+(?:restart|stop|start|reread|update|clear)\b |
        \bsystemctl\s+(?:restart|stop|start|disable|enable|reload|mask|kill)\b |
        (?:\bk3s\s+)?kubectl\s+(?:delete|scale|apply|patch|replace|edit|drain|cordon|taint|rollout|set|create|run|exec|label|annotate)\b |
        \bdocker(?:\s+compose)?\s+(?:restart|stop|start|down|up|rm|kill|prune)\b |
        \bkill(?:all)?\b | \bpkill\b |
        \btee\b |
        \bsed\s+-i\b |
        (?:^|\s)>(?!>|&)\s*\S
    )
    """
)

# 纯只读工具("all" 模式下也不拦)
_READ_TOOLS = {
    "read_file", "grep", "list_dir", "web_search", "fetch_url", "inspect",
    "memory_load", "memory_list", "browser_screenshot",
}


def classify(tool, args, runner):
    """判断一个 tool 调用是否需人工确认。返回理由(中文)或 None(放行)。"""
    m = mode()
    if m == "off" or _readonly:
        return None
    args = args or {}
    if m == "all":
        if tool in _READ_TOOLS:
            return None
        return f"审批模式=all:动作 {tool} 需确认"
    # --- high:仅高危写动作 ---
    if tool == "run":
        if runner == "pod":
            return None  # 容器内(cloud 自己的环境)不拦
        cmd = args.get("command", "") or ""
        if _denied_immediately(cmd):
            return None  # 已被 denylist 立即拒绝,无需排队
        if _WRITE_CMD_RE.search(cmd):
            return "命中高危写命令(宿主机 root):" + _cmd_brief(cmd)
        return None
    if tool == "run_remote":
        cmd = args.get("command", "") or ""
        if _denied_immediately(cmd):
            return None
        if _WRITE_CMD_RE.search(cmd):
            return "命中高危写命令(远程主机):" + _cmd_brief(cmd)
        return None
    if tool in ("write_file", "edit_file"):
        if runner == "pod":
            return None  # build agent 在容器内改自己的代码,不拦
        path = (args.get("path") or "").strip()
        if _host_path_denied(path):
            return None  # 已被宿主机路径护栏立即拒绝,无需排队
        if path and path != "/tmp" and not path.startswith("/tmp/"):
            return f"宿主机覆写非 /tmp 路径({tool}: {path})"
        return None
    return None


def _denied_immediately(cmd):
    """命令是否已被 agent 的 ops denylist 立即拒绝(是则不再进审批队列)。"""
    try:
        import agent
        return bool(agent._ops_denied(cmd))
    except Exception:
        return False


def _host_path_denied(path):
    """宿主机写路径是否已被 agent 的路径护栏拒绝。"""
    try:
        import agent
        return bool(agent._host_write_denied(path))
    except Exception:
        return False


def _cmd_brief(cmd):
    c = " ".join((cmd or "").split())
    return c[:120] + ("…" if len(c) > 120 else "")


# --- 存储 ---
def _load():
    try:
        with open(_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data
    except Exception:
        pass
    return {"seq": 0, "items": []}


def _save(data):
    """原子落盘,失败静默(不因审批记录写失败影响主流程)。"""
    try:
        tmp = _FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, _FILE)
    except Exception:
        pass


def _evict(items):
    """控制文件大小:保留全部 pending + 最近的已决记录。"""
    if len(items) <= _MAX_ITEMS:
        return items
    pending = [r for r in items if r.get("status") == "pending"]
    decided = [r for r in items if r.get("status") != "pending"]
    keep = decided[-(_MAX_ITEMS - len(pending)):] if len(pending) < _MAX_ITEMS else []
    return pending + keep


def _new_id(data):
    data["seq"] = int(data.get("seq", 0)) + 1
    return "ap-%s-%04d" % (datetime.utcnow().strftime("%Y%m%d%H%M%S"), data["seq"])


def _actor_name(user):
    if isinstance(user, dict):
        return user.get("username") or "system"
    return str(user or "system")


def gate(tool, args, runner, agent_def=None, pod=None, run_id=None, user=None):
    """审批闸入口(由 agent._exec_tool 调用)。

    需确认则登记 pending 并返回"已挂起"提示串;否则返回 None(正常执行)。
    """
    try:
        reason = classify(tool, args, runner)
        if not reason:
            return None
        return submit(tool, args, runner, agent_def, pod, run_id, user, reason)
    except Exception as e:
        # 分类/登记异常时保守放行既有自动化(denylist 仍在兜底)
        try:
            import audit
            audit.record("approval_error", detail=f"gate 异常: {e!r}", actor="approvals")
        except Exception:
            pass
        return None


def submit(tool, args, runner, agent_def, pod, run_id, user, reason, origin=None):
    """登记一条待确认写动作,返回提示串。相同(pending)动作去重。

    ``origin`` 标注记录来源(如 "podwatch"),仅用于前端区分「AI 建议」与
    人工/agent 触发的挂起动作;为空即普通来源,向后兼容旧调用点。
    """
    args = args or {}
    actor = _actor_name(user)
    aid = None
    reused = False
    with _LOCK:
        data = _load()
        # 去重:同一 actor+tool+args 已有 pending 时复用
        sig = json.dumps({"t": tool, "a": args}, ensure_ascii=False, sort_keys=True)
        for r in data.get("items", []):
            if r.get("status") == "pending" and r.get("actor") == actor and \
                    json.dumps({"t": r.get("tool"), "a": r.get("args", {})},
                               ensure_ascii=False, sort_keys=True) == sig:
                aid = r["id"]
                reused = True
                break
        if aid is None:
            aid = _new_id(data)
            rec = {
                "id": aid,
                "ts": datetime.utcnow().isoformat(),
                "actor": actor,
                "role": (user or {}).get("role") if isinstance(user, dict) else "",
                "tool": tool,
                "args": args,
                "runner": runner,
                "pod": pod or "",
                "agent_id": (agent_def or {}).get("id", "") if agent_def else "",
                "run_id": run_id or "",
                "reason": reason,
                "origin": origin or "",
                "status": "pending",
                "decided_ts": None,
                "decided_by": None,
                "executed_ts": None,
                "exec_ok": None,
                "exec_out": "",
                "verify": None,
            }
            data.setdefault("items", []).append(rec)
            data["items"] = _evict(data["items"])
            _save(data)
    try:
        import audit
        audit.record("approval_pending",
                     detail=f"id={aid} tool={tool} runner={runner} reason={reason}",
                     actor=actor)
    except Exception:
        pass
    # 新 pending 记录 → 推送 admin 群(kind='approval-pending')。同一 pod 5 分钟
    # 内多条 pending 合并成一条(event_key 带时间桶); 去重记录复用时不重推。
    # 收件人是 admin(has_perm('infra.host')/admin/super), notify_event 按组解析
    # 发不到, 走 cert_alerts.notify_admins 直发。独立线程, 不阻塞提交流程。
    if not reused:
        threading.Thread(target=_notify_pending, args=(pod, reason),
                         daemon=True).start()
    return (f"【已挂起,等待确认(approval id={aid})】本次未执行。该动作属需确认的写操作,"
            f"已登记审批队列,请勿重复提交;由具备 admin/infra.host 权限者经 "
            f"POST /api/agents/approve 批准后执行,或 /api/agents/reject 作废。可继续其它只读步骤。")


def _notify_pending(pod, reason):
    """推送 admin: 有新的待审批 AI 命令(合并去重, best-effort)。"""
    try:
        import cert_alerts
        brief = " ".join(str(reason or "").split())[:80]
        scope = pod or "host"
        bucket = int(time.time() // 300)  # 5 分钟桶: 同一 pod 多条 pending 合并
        cert_alerts.notify_admins(
            f"approval:{scope}:{bucket}", "approval-pending",
            "AI 待审批命令",
            f"AI 待审批命令:{brief}" + (f"(pod: {pod})" if pod else ""),
            url="/ops/approvals", urgency="high")
    except Exception:
        pass


# --- 查询 ---
def get(aid):
    with _LOCK:
        for r in _load().get("items", []):
            if r.get("id") == aid:
                return r
    return None


def list_records(status=None, limit=50):
    with _LOCK:
        items = list(_load().get("items", []))
    if status == "done":
        # "done" is the UI's umbrella for anything already decided.
        items = [r for r in items if r.get("status") != "pending"]
    elif status and status != "all":
        items = [r for r in items if r.get("status") == status]
    return list(reversed(items))[:limit]


# --- 审批执行 ---
def approve(aid, actor_user=None):
    """批准并执行一条挂起动作。返回 (ok, message)。"""
    rec = get(aid)
    if not rec:
        return False, f"审批记录不存在: {aid}"
    if rec.get("status") != "pending":
        return False, f"该动作已处理(status={rec.get('status')})"
    by = _actor_name(actor_user)
    # "下次同类操作":批准前顺带核验上一批待核验动作(只读,best-effort)
    try:
        verify_pending(limit=3)
    except Exception:
        pass
    try:
        import agent
        ok, out = agent.resume_approved(rec, user=actor_user)
    except Exception as e:
        ok, out = False, f"执行异常: {e!r}"
    with _LOCK:
        data = _load()
        for r in data.get("items", []):
            if r.get("id") == aid:
                r["status"] = "executed" if ok else "failed"
                r["decided_ts"] = datetime.utcnow().isoformat()
                r["decided_by"] = by
                r["executed_ts"] = datetime.utcnow().isoformat()
                r["exec_ok"] = bool(ok)
                r["exec_out"] = str(out)[:2000]
                if ok:
                    vcmd = build_verify_cmd(r)
                    if vcmd:
                        r["verify"] = {"cmd": vcmd, "status": "pending",
                                       "ts": None, "out": ""}
                break
        _save(data)
    try:
        import audit
        audit.record("approval_approve",
                     detail=f"id={aid} ok={ok} by={by} out={str(out)[:300]}",
                     actor=by)
    except Exception:
        pass
    return ok, out


def reject(aid, actor_user=None, reason=""):
    """拒绝/作废一条挂起动作。返回 (ok, message)。"""
    rec = get(aid)
    if not rec:
        return False, f"审批记录不存在: {aid}"
    if rec.get("status") != "pending":
        return False, f"该动作已处理(status={rec.get('status')})"
    by = _actor_name(actor_user)
    with _LOCK:
        data = _load()
        for r in data.get("items", []):
            if r.get("id") == aid:
                r["status"] = "rejected"
                r["decided_ts"] = datetime.utcnow().isoformat()
                r["decided_by"] = by
                r["exec_out"] = str(reason or "")[:500]
                break
        _save(data)
    try:
        import audit
        audit.record("approval_reject", detail=f"id={aid} by={by} reason={reason}", actor=by)
    except Exception:
        pass
    return True, f"已拒绝并作废 {aid}"


# --- 事后核验闭环 ---
def build_verify_cmd(rec):
    """为一个已执行的写动作构造**只读**核验命令(无法构造则返回 None)。"""
    tool = rec.get("tool")
    args = rec.get("args") or {}
    if tool in ("run", "run_remote"):
        cmd = args.get("command", "") or ""
        if re.search(r"(?i)\bsystemctl\s+(?:restart|stop|start)\s+([\w.@-]+)", cmd):
            unit = re.search(r"(?i)\bsystemctl\s+(?:restart|stop|start)\s+([\w.@-]+)", cmd).group(1)
            return f"systemctl is-active {unit} 2>&1; systemctl --no-pager --lines=0 status {unit} 2>&1 | head -5"
        m = re.search(r"(?i)\bsupervisorctl\s+(?:restart|stop|start)\s+([\w.:-]+)", cmd)
        if m:
            return f"supervisorctl status {m.group(1)} 2>&1"
        m = re.search(r"(?i)kubectl\s+(?:delete|scale|apply|patch|rollout|edit|replace)\s+(\w+)\s*([^\s|;]*)?", cmd)
        if m:
            kind, name = m.group(1), (m.group(2) or "").lstrip("/")
            if name:
                return f"kubectl get {kind} {name} -A 2>&1 || kubectl get {kind} {name} 2>&1"
            return f"kubectl get {kind} -A 2>&1 | head -30"
        m = re.search(r"(?i)\bdocker(?:\s+compose)?\s+(?:restart|stop|start|up|down)\s*([^\s|;]*)?", cmd)
        if m:
            svc = (m.group(1) or "").strip()
            return (f"docker compose ps {svc} 2>&1 || docker ps -a --filter name={svc} 2>&1"
                    if svc else "docker compose ps 2>&1 || docker ps -a 2>&1")
        # rm/rmdir/mv:确认目标是否已消失
        m = re.search(r"(?i)\b(?:rm|rmdir)\b[^\s]*\s+(?:-[^\s]+\s+)*([^\s|;&]+)", cmd)
        if m:
            tgt = m.group(1)
            if tgt.startswith("/") or tgt.startswith("~"):
                import shlex
                return f"test -e {shlex.quote(tgt)} && echo '仍存在' || echo '已删除'"
        # truncate/chmod/chown:看目标元数据
        m = re.search(r"(?i)\b(?:truncate|chmod|chown)\b[^\n]*?\s([^\s|;&]+)$", cmd)
        if m and m.group(1).startswith("/"):
            import shlex
            return f"ls -ld {shlex.quote(m.group(1))} 2>&1"
        return None
    if tool in ("write_file", "edit_file"):
        path = (args.get("path") or "").strip()
        if path:
            import shlex
            return f"ls -l {shlex.quote(path)} 2>&1"
    return None


def _run_verify(rec, vcmd):
    """执行只读核验命令,返回 (ok, out)。按记录的 runner 决定执行位置。"""
    import agent
    runner = rec.get("runner")
    if rec.get("tool") == "run_remote":
        import remote_hosts
        return remote_hosts.run_remote((rec.get("args") or {}).get("host", ""),
                                       vcmd, sudo=False, timeout=15)
    if runner == "pod" and rec.get("pod"):
        return agent._run_in_pod(rec["pod"], vcmd, 15)
    return agent._run_host(vcmd, 15)


def verify_pending(limit=5):
    """执行若干待核验记录(只读),结果写 audit + agent_memory。返回 (n, results)。"""
    todo = []
    with _LOCK:
        for r in _load().get("items", []):
            if r.get("status") == "executed" and isinstance(r.get("verify"), dict) \
                    and r["verify"].get("status") == "pending":
                todo.append(r["id"])
    todo = todo[-max(1, int(limit)):]
    results = []
    for aid in todo:
        rec = get(aid)
        if not rec or not rec.get("verify"):
            continue
        vcmd = rec["verify"].get("cmd")
        try:
            ok, out = _run_verify(rec, vcmd)
        except Exception as e:
            ok, out = False, f"核验异常: {e!r}"
        out_s = str(out or "")[:500]
        with _LOCK:
            data = _load()
            for r in data.get("items", []):
                if r.get("id") == aid and isinstance(r.get("verify"), dict):
                    r["verify"]["status"] = "ok" if ok else "fail"
                    r["verify"]["ts"] = datetime.utcnow().isoformat()
                    r["verify"]["out"] = out_s
                    break
            _save(data)
        # 写入 audit + agent_memory
        try:
            import audit
            audit.record("approval_verify",
                         detail=f"id={aid} cmd={vcmd} ok={ok} out={out_s[:200]}",
                         actor="approvals")
        except Exception:
            pass
        try:
            import agent_memory
            ns = rec.get("agent_id") or "ops"
            agent_memory.save(ns, f"verify:{aid}",
                              f"[{'OK' if ok else 'FAIL'}] {vcmd} -> {out_s[:300]}")
        except Exception:
            pass
        results.append({"id": aid, "cmd": vcmd, "ok": ok, "out": out_s})
    return len(results), results


# --- HTTP 端点(仅 admin+/infra.host 可用) ---
# 说明:本蓝图由 app.py 在启动时显式 register_blueprint(approvals.approvals_bp) 注册。
try:
    from flask import Blueprint, request, jsonify
    import users

    approvals_bp = Blueprint("api_approvals", __name__, url_prefix="/api/agents")

    def _resolve_actor():
        """解析当前操作者(Bearer token > session),失败返回 None。"""
        try:
            from flask import g
            u = getattr(g, "api_user", None)
            if u:
                return u
        except Exception:
            pass
        try:
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                info = users.verify_token(auth[7:])
                if info:
                    return info
        except Exception:
            pass
        try:
            from flask import session
            if session.get("logged_in"):
                u = users.get_user(session.get("user"))
                if u:
                    return u
        except Exception:
            pass
        return None

    def _is_approver(u):
        if not u:
            return False
        try:
            if (u.get("role") or "") in ("super", "admin"):
                return True
            return bool(users.has_perm(u, "infra.host"))
        except Exception:
            return False

    def _as_int(v, default, lo=1, hi=200):
        try:
            return max(lo, min(hi, int(v)))
        except Exception:
            return default

    def _deny():
        u = _resolve_actor()
        if not u:
            return jsonify({"error": {"code": "UNAUTHORIZED",
                                      "message": "需要登录"}}), 401
        if not _is_approver(u):
            return jsonify({"error": {"code": "FORBIDDEN",
                                      "message": "需要 admin 或 infra.host 权限"}}), 403
        return u

    @approvals_bp.route("/approvals", methods=["GET"])
    def approvals_list():
        u = _deny()
        if not isinstance(u, dict):
            return u
        status = (request.args.get("status") or "pending").strip()
        recs = list_records(status=status, limit=_as_int(request.args.get("limit"), 50))
        return jsonify({"approvals": recs, "mode": mode()})

    @approvals_bp.route("/approve", methods=["POST"])
    def approvals_approve():
        u = _deny()
        if not isinstance(u, dict):
            return u
        body = request.get_json(silent=True) or {}
        aid = (body.get("id") or "").strip()
        if not aid:
            return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 id"}}), 400
        ok, msg = approve(aid, actor_user=u)
        return jsonify({"ok": ok, "message": msg, "id": aid}), (200 if ok else 400)

    @approvals_bp.route("/reject", methods=["POST"])
    def approvals_reject():
        u = _deny()
        if not isinstance(u, dict):
            return u
        body = request.get_json(silent=True) or {}
        aid = (body.get("id") or "").strip()
        if not aid:
            return jsonify({"error": {"code": "BAD_REQUEST", "message": "缺少 id"}}), 400
        ok, msg = reject(aid, actor_user=u, reason=body.get("reason", ""))
        return jsonify({"ok": ok, "message": msg, "id": aid}), (200 if ok else 400)

    @approvals_bp.route("/approvals/verify", methods=["POST"])
    def approvals_verify():
        u = _deny()
        if not isinstance(u, dict):
            return u
        n, results = verify_pending(limit=_as_int((request.get_json(silent=True) or {}).get("limit"), 5))
        return jsonify({"ok": True, "checked": n, "results": results})

    _HAS_BP = True
except Exception:
    approvals_bp = None
    _HAS_BP = False
    import logging
    logging.getLogger("approvals").exception("审批蓝图创建失败,/api/agents/approvals 等端点将不可用")

# app.py 启动时 import 本模块(approvals), 借此拉起 cert_alerts 的证书到期/
# 攻击激增检查线程(同 podwatch 的 import 自启模式; app.py 不归本包改)。
try:
    import cert_alerts  # noqa: F401
except Exception:
    import logging
    logging.getLogger("approvals").exception("cert_alerts 启动失败")

