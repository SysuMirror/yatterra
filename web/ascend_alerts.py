#!/usr/bin/env python3
"""Ascend-lab tunnel watchdog — 实验室链路掉线告警（kind=lab-link）。

背景
----
昇腾实验室（训练机 178.127.1.2 / BMC …）只能经 **`group-ascend910b` pod 里那
个手工起的 uvpn 会话**（用户态 SOCKS5 127.0.0.1:7890）到达，而实验室网关**每次
登录强制短信/邮箱验证码**，所以会话**不可能自愈**：pod 一被重建（或进程一死），
隧道就一直断着，直到有人收到新验证码再喂进去。2026-11-17 正是如此，断了约 35
小时才被发现。

本检查从 gw pod **内部**拨一把真实的端到端路径 —— 经该会话 `uvpn dial
<lab>:22`，实验室 sshd 应当回 `SSH-2.0-…` banner —— 失败就发一条 `lab-link`
告警，于是这种「静默」故障几分钟内就能被看见，而不是几天。

只探测 + 告警，**不自动重连**：重连也只是停在 READY-FOR-CODE 等人工码，
反复启停会话反而会重复触发网关发码。

接入方式与 host_alerts 完全一致（由 `pwa_alerts.monitor_once` 调用）：同一个
`_claim_alert` at-most-once 通道、同一批收件人（admin）、同一份通知中心留痕。

kinds（与 pwa_alerts._KIND_LABELS 对齐）: lab-link
Tunables（env）: YATTERRA_ALERT_LAB_NS (clouds), _LAB_DEPLOY (group-ascend910b),
_LAB_HOST (178.127.1.2), _LAB_PORT (22), _LAB_POLL_S (60), _LAB_TIMEOUT (25),
_LAB_BUCKET_S (3600)；YATTERRA_ASCEND_ALERTS_DISABLED=1 可整体关闭。
"""
import logging
import os
import subprocess
import time

log = logging.getLogger("ascend_alerts")

NS = os.environ.get("YATTERRA_ALERT_LAB_NS", "clouds")
DEPLOY = os.environ.get("YATTERRA_ALERT_LAB_DEPLOY", "group-ascend910b")
LAB_HOST = os.environ.get("YATTERRA_ALERT_LAB_HOST", "178.127.1.2")
LAB_PORT = os.environ.get("YATTERRA_ALERT_LAB_PORT", "22")
# 探测节流：monitor 循环每 ~15s 调一次，但真正拨号不必那么勤。
POLL_S = max(30.0, float(os.environ.get("YATTERRA_ALERT_LAB_POLL_S", "60")))
TIMEOUT = max(5.0, float(os.environ.get("YATTERRA_ALERT_LAB_TIMEOUT", "25")))
# 持续不通时每 bucket 提醒一次（别每轮刷屏）。
BUCKET_S = max(300.0, float(os.environ.get("YATTERRA_ALERT_LAB_BUCKET_S", "3600")))
DISABLED = (os.environ.get("YATTERRA_ASCEND_ALERTS_DISABLED", "").strip().lower()
            in ("1", "true", "yes", "on"))
ALERT_URL = "/infra/host"

_last_probe = 0.0

# 在 gw pod 里执行：真拨一把实验室 sshd 的 22 端口，收到 SSH banner 才算通。
# 只用 dial（不 pgrep —— 探测脚本正文里出现 "uvpn connect" 会自匹配）。
PROBE = (
    'cd /home/cloud/uvpn 2>/dev/null || { echo "probe:no-uvpn-dir"; exit 0; }\n'
    'out=$(timeout 8 ./uvpn dial ' + LAB_HOST + ':' + LAB_PORT + ' </dev/null 2>&1 | head -c 200)\n'
    'case "$out" in\n'
    '  SSH-*) echo ok ;;\n'
    '  *)     echo "down:${out:-empty}" ;;\n'
    'esac\n'
)


# --------------------------------------------------------------------------- #
# helpers（与 host_alerts / cert_alerts 同款收件人与留痕语义）
# --------------------------------------------------------------------------- #
def _admins():
    """Admin usernames — identical policy to host_alerts / pressure_writer."""
    import users
    return [u["username"] for u in users.list_users()
            if (u.get("role") or "") in ("super", "admin")
            or users.has_perm(u, "infra.host")]


def _fire(kind, ident, title, body, urgency="normal", bucket_s=BUCKET_S):
    """Claim + push one lab alert. True only if this call claimed it. Never raises."""
    try:
        admins = _admins()
        if not admins:
            return False
        import pwa_alerts
        from api.push import send_to_users
        bucket = int(time.time() // bucket_s)
        event_key = f"ascendalert:{kind}:{ident}:{bucket}"
        pwa_alerts.init_db()
        stored = {"title": title, "body": body, "url": ALERT_URL}
        if not pwa_alerts._claim_alert(event_key, kind, "platform", stored, admins):
            return False
        send_to_users(admins, {
            "title": title, "body": body, "url": ALERT_URL,
            "type": kind, "event_key": event_key, "urgency": urgency})
        return True
    except Exception:
        log.exception("lab alert %s/%s failed", kind, ident)
        return False


def _probe():
    """拨号探测。返回 (ok, detail)；探测本身不可信时返回 None。

    只有在 pod 内**真的跑通了探测脚本**并明确回了 down 才报警。kubectl 这一层
    失败（pod 正在重建 / 容器不在 / 连不上 apiserver）一律视为「测不了」→ None：
    那种情况 pod-down 告警已经覆盖，不该再叠一条，也避免误报。
    """
    try:
        r = subprocess.run(
            ["kubectl", "-n", NS, "exec", "deploy/" + DEPLOY, "--",
             "bash", "-lc", PROBE],
            capture_output=True, text=True, timeout=TIMEOUT)
    except Exception:
        log.info("lab probe spawn failed", exc_info=True)
        return None
    lines = (r.stdout or "").strip().splitlines()
    line = lines[-1].strip() if lines else ""
    if line == "ok":
        return (True, "ok")
    if line.startswith("down:"):
        return (False, line[5:].strip()[:200] or "dial failed")
    log.info("lab probe inconclusive (rc=%s): %s", r.returncode,
             ((r.stderr or "").strip() or line)[:200])
    return None


# --------------------------------------------------------------------------- #
# check
# --------------------------------------------------------------------------- #
def check_lab_link(force=False):
    """实验室隧道不通时（每 BUCKET_S 至多一次）发一条 lab-link 告警。"""
    global _last_probe
    now = time.time()
    if not force and now - _last_probe < POLL_S:
        return 0
    _last_probe = now
    pr = _probe()
    if pr is None:
        return 0
    ok, detail = pr
    if ok:
        return 0
    return int(bool(_fire(
        "lab-link", "ascend",
        "昇腾实验室链路中断",
        f"到实验室训练机 {LAB_HOST} 的隧道不通 —— 会话是 {DEPLOY} pod 里那个手工起的 "
        f"uvpn（实验室网关每次登录强制人工短信码），掉线后不会自愈，得人去收码。"
        f"现象：{detail}。恢复：进该 pod 跑 uvpn-up.sh，收到码后 uvpn-code.sh <CODE>。",
        urgency="high", bucket_s=BUCKET_S)))


def run_checks(force=False):
    """跑实验室检查，返回本轮认领的告警数。永不抛（坏了不能拖垮 monitor 循环）。"""
    if DISABLED:
        return 0
    try:
        return int(check_lab_link(force=force) or 0)
    except Exception:
        log.exception("ascend lab check failed")
        return 0


def _dry(force):
    """不认领不推送，只报告「会不会报」。"""
    pr = _probe()
    print("probe:", pr)
    if pr is None:
        print("dry: inconclusive (would not alert)")
    elif pr[0]:
        print("dry: link up (would not alert)")
    else:
        print(f"dry: WOULD alert lab-link :: {pr[1]}")


if __name__ == "__main__":
    import sys
    if "--dry" in sys.argv[1:]:
        _dry("--force" in sys.argv[1:])
    else:
        print("fired:", run_checks(force="--force" in sys.argv[1:]))
