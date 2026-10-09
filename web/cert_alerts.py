#!/usr/bin/env python3
"""证书到期检查 + 攻击激增检查(后台守护线程, import 时自启)。

启动模式同 podwatch/insight: 模块被 app.py 加载链上的模块(approvals.py
底部)import, 单个 daemon 线程幂等启动, 所有错误吞掉, 不影响主服务。
env YATTERRA_CERT_ALERTS_DISABLED=1 可关闭。

职责:
  1) 证书到期: 每 YATTERRA_CERT_CHECK_S(默认 6h)用 ssl socket 探测
     YATTERRA_CERT_CHECK_HOSTS(默认 'ssemarket.cn:443,cloud.ssemarket.cn:443')
     取 notAfter, 剩余 < 7 天时推送 admin(kind='cert-expiry', urgency=high)。
     event_key=f"cert:{host}:{到期日}" —— 同一张证书只推一次, 续期后新证书
     新 event_key 会再推(提前预警)。
  2) 攻击激增: 每 YATTERRA_ATTACK_CHECK_S(默认 6h)读蜜罐 feed_1d.json 的
     stats.total_banned(1 天窗口即单日增量), 超过
     YATTERRA_ATTACK_SURGE_THRESHOLD(默认 500)时推送 admin(kind='attack-surge')。
     event_key 带日期, 同一天只推一次。threat_map API 是拉取型没有常驻点,
     检查线程放这里(同款模式)。

本模块还提供 notify_admins()/notify_user() 两个直发 helper: pwa_alerts.
notify_event 的收件人按组解析, 无法指定"admin 群"或"单个用户", 所以这里
借用 pwa_alerts._claim_alert(内部函数, at-most-once 去重 + 通知中心留痕)
后直接调 api/push.send_to_users 定向发送。本包(approvals/agent_runs/
llm_usage/pressure_writer)统一复用, 不各自复制一份。
"""
import json
import logging
import os
import socket
import ssl
import threading
import time
from datetime import datetime

import siteconf

log = logging.getLogger(__name__)

CHECK_S = max(300.0, float(os.environ.get("YATTERRA_CERT_CHECK_S", "21600")))
ATTACK_CHECK_S = max(300.0, float(os.environ.get("YATTERRA_ATTACK_CHECK_S", "21600")))
CERT_HOSTS = (os.environ.get("YATTERRA_CERT_CHECK_HOSTS")
              or "ssemarket.cn:443,cloud.ssemarket.cn:443")
CERT_WARN_DAYS = max(1, int(os.environ.get("YATTERRA_CERT_WARN_DAYS", "7")))
ATTACK_THRESHOLD = int(os.environ.get("YATTERRA_ATTACK_SURGE_THRESHOLD", "500") or 0)

_started = False
_lock = threading.Lock()


# --- 定向推送 helper(本包共用) --------------------------------------------
def _claim(event_key, kind, group, title, body, url, recipients=None):
    """pwa_alerts 去重留痕(借用内部 _claim_alert: notify_event 无法指定收件人,
    但去重语义必须与通知中心一致)。返回 True 表示本次抢到(应发送)。

    recipients 落进 alert_event, 决定该事件在通知中心对谁可见 —— 必须与
    实际 _send 的目标一致, 否则会出现"推了却看不到/看得到却没推"的偏差。
    """
    import pwa_alerts
    pwa_alerts.init_db()
    # 借用内部函数是刻意取舍: 公开 API notify_event 的收件人按组解析,
    # 发不了"admin 群/单用户"; _claim_alert 是纯 SQLite INSERT OR IGNORE,
    # 语义稳定(at-most-once, 重启安全)。
    return pwa_alerts._claim_alert(event_key, kind, group,
                                   {"title": title, "body": body, "url": url},
                                   recipients)


def _send(usernames, event_key, kind, title, body, url, urgency):
    from api.push import send_to_users
    # payload 里的 urgency/topic 由 api/push 的 webpush 层消费(缺省 'normal')
    return send_to_users(usernames, {"title": title, "body": body, "url": url,
                                     "type": kind, "event_key": event_key,
                                     "urgency": urgency})


def admin_users():
    """具备审批权的用户: admin/super 角色或持有 infra.host 权限。"""
    try:
        import users
        out = []
        for u in users.list_users():
            if (u.get("role") or "") in ("super", "admin") \
                    or users.has_perm(u, "infra.host"):
                out.append(u["username"])
        return out
    except Exception:
        log.exception("admin_users resolve failed")
        return []


def notify_admins(event_key, kind, title, body, url="/", urgency="high"):
    """推送 admin 群(at-most-once, 按 event_key 去重)。不抛异常。"""
    try:
        admins = admin_users()
        if not _claim(event_key, kind, "platform", title, body, url, admins):
            return False
        _send(admins, event_key, kind, title, body, url, urgency)
        return True
    except Exception:
        log.exception("notify_admins failed for %s", event_key)
        return False


def notify_user(username, event_key, kind, title, body, url="/", urgency="normal"):
    """推送单个用户(at-most-once, 按 event_key 去重)。不抛异常。"""
    try:
        if not username:
            return False
        if not _claim(event_key, kind, str(username), title, body, url, [username]):
            return False
        _send([username], event_key, kind, title, body, url, urgency)
        return True
    except Exception:
        log.exception("notify_user failed for %s", event_key)
        return False


# --- 证书到期检查 -----------------------------------------------------------
def _parse_hosts(spec):
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            host, _, port = part.rpartition(":")
            try:
                out.append((host.strip(), int(port)))
                continue
            except ValueError:
                pass
        out.append((part, 443))
    return out


def cert_not_after(host, port=443, timeout=10):
    """返回证书 notAfter 的 epoch 秒, 失败返回 None。"""
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            ctx = ssl.create_default_context()
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
        return ssl.cert_time_to_seconds(cert.get("notAfter", ""))
    except Exception as exc:
        log.warning("cert probe failed for %s:%s: %s", host, port, exc)
        return None


def check_certs_once():
    """探测全部配置域名, 剩余 < CERT_WARN_DAYS 天时推 admin(每证书一次)。"""
    for host, port in _parse_hosts(CERT_HOSTS):
        try:
            na = cert_not_after(host, port)
            if not na:
                continue
            days_left = (na - time.time()) / 86400.0
            if days_left >= CERT_WARN_DAYS:
                continue
            expiry = datetime.fromtimestamp(na).strftime("%Y-%m-%d")
            notify_admins(
                f"cert:{host}:{expiry}", "cert-expiry",
                "证书即将到期",
                f"「{host}」的 HTTPS 证书将于 {expiry} 到期(剩余 {max(0, int(days_left))} 天),请尽快续期。",
                url="/infra/host", urgency="high")
        except Exception:
            log.exception("cert check failed for %s", host)


# --- 攻击激增检查 -----------------------------------------------------------
def check_attack_surge_once():
    """蜜罐 1d 窗口 total_banned 超阈值时推 admin(每天一次)。"""
    if ATTACK_THRESHOLD <= 0:
        return
    try:
        path = os.path.join(siteconf.HONEYPOT_DIR, "feed_1d.json")
        with open(path) as f:
            data = json.load(f)
        total = int(((data.get("stats") or {}).get("total_banned")) or 0)
        if total < ATTACK_THRESHOLD:
            return
        today = datetime.now().strftime("%Y-%m-%d")
        notify_admins(
            f"attack-surge:{today}:{total}", "attack-surge",
            "攻击激增提醒",
            f"蜜罐单日封禁 IP 达 {total} 个(阈值 {ATTACK_THRESHOLD}),请关注攻防页面。",
            url="/threat-map", urgency="normal")
    except Exception:
        log.exception("attack surge check failed")


def _loop():
    while True:
        try:
            check_certs_once()
        except Exception:
            log.exception("cert loop iteration failed")
        try:
            check_attack_surge_once()
        except Exception:
            log.exception("attack surge loop iteration failed")
        time.sleep(min(CHECK_S, ATTACK_CHECK_S))


def start():
    """幂等启动守护线程(import 时自启, 同 podwatch 模式)。"""
    global _started
    if _started or os.environ.get("YATTERRA_CERT_ALERTS_DISABLED"):
        return
    with _lock:
        if _started:
            return
        t = threading.Thread(target=_loop, name="cert-alerts", daemon=True)
        t.start()
        _started = True
        log.info("cert_alerts thread started (cert hosts=%s, interval=%ss)",
                 CERT_HOSTS, min(CHECK_S, ATTACK_CHECK_S))


start()
