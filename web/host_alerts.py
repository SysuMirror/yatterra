#!/usr/bin/env python3
"""Host-level alert checks — the gap the pod monitor never covered.

``pwa_alerts.monitor()`` only watches *Pod* readiness (pod-down/recovery). Nothing
watched the host or the platform's own daemons, so a full disk, exhausted swap, a
GPU running hot, a remote fleet host going away, or a silently-dead watcher
daemon would go unnoticed until something broke loudly. This module adds those
checks. It is called from the monitor loop (``pwa_alerts.monitor_once``) so there
is still exactly one root daemon and one alert pipeline.

Design
------
- Reuses ``pwa_alerts._claim_alert`` (at-most-once, SQLite-backed) + the
  ``api.push`` Web Push path, exactly like ``pressure_writer``'s pressure alerts:
  same notification-centre trail, same recipients (admins), so the centre view
  and the push target can never disagree.
- Deduped per ``(kind, ident, bucket)``: a check that keeps tripping re-notifies
  at most once per bucket instead of every 15s poll.
- ``run_checks()`` never raises: a broken check must not take down the Pod
  monitor. Each check logs and returns the number of alerts it claimed.

Alert kinds (kept in sync with pwa_alerts._KIND_LABELS)
------------------------------------------------------
host-disk, host-swap, gpu-temp, fleet-offline, fleet-stale, daemon-down

Tunables (env): YATTERRA_ALERT_DISK_WARN (0.90), _DISK_CRIT (0.95),
_SWAP_WARN (0.50), _GPU_TEMP_WARN (85), _GPU_TEMP_CRIT (93), _FLEET_OFFLINE_S
(300), _PRESSURE_STALE_S (90), _BUCKET_S (900), _PRESSURE_FILE.
"""
import json
import logging
import os
import shutil
import subprocess
import time

import siteconf

log = logging.getLogger("host_alerts")

DISK_WARN = float(os.environ.get("YATTERRA_ALERT_DISK_WARN", "0.90"))
DISK_CRIT = float(os.environ.get("YATTERRA_ALERT_DISK_CRIT", "0.95"))
SWAP_WARN = float(os.environ.get("YATTERRA_ALERT_SWAP_WARN", "0.50"))
GPU_TEMP_WARN = float(os.environ.get("YATTERRA_ALERT_GPU_TEMP_WARN", "85"))
GPU_TEMP_CRIT = float(os.environ.get("YATTERRA_ALERT_GPU_TEMP_CRIT", "93"))
# A remote host is "gone" once its newest sample is older than this. The sampler
# itself marks unreachable hosts 'offline' *with a fresh timestamp*, so this
# threshold catches the other failure mode: the sampler (or the host's probe)
# stopped producing rows at all.
FLEET_OFFLINE_S = float(os.environ.get("YATTERRA_ALERT_FLEET_OFFLINE_S", "300"))
# pressure_writer publishes every ~2s; if the file goes stale the Pod-side
# degradation signal and priority_kill are both running blind.
PRESSURE_STALE_S = float(os.environ.get("YATTERRA_ALERT_PRESSURE_STALE_S", "90"))
BUCKET_S = max(60.0, float(os.environ.get("YATTERRA_ALERT_BUCKET_S", "900")))
PRESSURE_FILE = os.environ.get(
    "YATTERRA_ALERT_PRESSURE_FILE",
    os.path.join(siteconf.PRESSURE_DIR, "pressure.json"))

# Root daemons whose silence must not go unnoticed. Only *existing* units are
# alerted on: `systemctl is-active` on an unknown unit also returns non-zero, so
# an unknown/unsupported answer is treated as "can't tell" and skipped.
WATCHED_UNITS = tuple(
    u.strip() for u in os.environ.get(
        "YATTERRA_ALERT_UNITS",
        "yatterra-web,sse-pressure-writer,sse-priority-kill,gpu-scheduler,"
        "yatterra-fleet-sampler,yatterra-pwa-alert-monitor,yatterra-req-estimator",
    ).split(",") if u.strip())

ALERT_URL = "/infra/host"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _human(n):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{int(n)} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} TiB"


def _admins():
    """Admin usernames — identical policy to pressure_writer / cert_alerts."""
    import users
    return [u["username"] for u in users.list_users()
            if (u.get("role") or "") in ("super", "admin")
            or users.has_perm(u, "infra.host")]


def _fire(kind, ident, title, body, urgency="normal", bucket_s=BUCKET_S):
    """Claim + push one host alert. True only if this call claimed it.

    event_key carries the dedup bucket, so a persistent condition (a disk that
    stays full) re-notifies once per bucket, not once per poll. Never raises.
    """
    try:
        admins = _admins()
        if not admins:
            return False
        import pwa_alerts
        from api.push import send_to_users
        bucket = int(time.time() // bucket_s)
        event_key = f"hostalert:{kind}:{ident}:{bucket}"
        pwa_alerts.init_db()
        stored = {"title": title, "body": body, "url": ALERT_URL}
        if not pwa_alerts._claim_alert(event_key, kind, "platform", stored, admins):
            return False
        send_to_users(admins, {
            "title": title, "body": body, "url": ALERT_URL,
            "type": kind, "event_key": event_key, "urgency": urgency})
        return True
    except Exception:
        log.exception("host alert %s/%s failed", kind, ident)
        return False


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
def check_disk():
    """Alert per mount whose used fraction is past DISK_WARN/CRIT."""
    fired = 0
    for mount in (getattr(siteconf, "DISK_MOUNTS", None) or ["/"]):
        try:
            u = shutil.disk_usage(mount)
        except Exception:
            continue
        if not u.total:
            continue
        used = u.used / u.total
        if used < DISK_WARN:
            continue
        crit = used >= DISK_CRIT
        pct = round(used * 100)
        tail = ("磁盘即将写满, 请立即清理以免 Pod 写入失败。"
                if crit else "请安排清理 (日志/缓存/镜像通常是元凶)。")
        fired += bool(_fire(
            "host-disk", mount,
            f"主机磁盘 {pct}% 已用 ({mount})",
            f"挂载点 {mount} 已用 {pct}%"
            f" ({_human(u.used)}/{_human(u.total)}, 剩余 {_human(u.free)})。{tail}",
            urgency="high" if crit else "normal"))
    return fired


def check_swap():
    """Alert when swap usage is past SWAP_WARN (memory pressure spillover)."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0]) * 1024
        total = info.get("SwapTotal", 0)
        if not total:
            return 0
        used = (total - info.get("SwapFree", 0)) / total
    except Exception:
        return 0
    if used < SWAP_WARN:
        return 0
    pct = round(used * 100)
    return int(bool(_fire(
        "host-swap", "swap",
        f"主机交换分区 {pct}% 已用",
        f"Swap 已用 {pct}% ({_human(total * used)}/{_human(total)})。"
        f"通常意味着内存吃紧, 可能拖慢全部 Pod; 建议排查内存大户或降载。",
        urgency="high" if used >= 0.8 else "normal")))


def _gpu_temp():
    """Max GPU temperature: from pressure.json first (already sampled every 2s),
    falling back to a direct nvidia-smi probe. None when unavailable."""
    try:
        with open(PRESSURE_FILE) as f:
            p = json.load(f)
        t = p.get("gpu_temp_max")
        if isinstance(t, (int, float)):
            return float(t)
        temps = [c.get("temp") for c in (p.get("gpu_cards") or [])
                 if isinstance(c, dict) and isinstance(c.get("temp"), (int, float))]
        if temps:
            return float(max(temps))
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            vals = [float(x) for x in r.stdout.split() if x.strip()]
            if vals:
                return max(vals)
    except Exception:
        pass
    return None


def check_gpu_temp():
    """Alert on a hot GPU (throttling starts well before the driver limit)."""
    t = _gpu_temp()
    if t is None or t < GPU_TEMP_WARN:
        return 0
    crit = t >= GPU_TEMP_CRIT
    return int(bool(_fire(
        "gpu-temp", "max",
        f"GPU 温度 {round(t)}°C",
        f"GPU 最高温度 {round(t)}°C (阈值 {GPU_TEMP_WARN:.0f}°C)"
        f"{', 已接近降频/急停' if crit else ''}。建议降低负载或检查散热/风道。",
        urgency="high" if crit else "normal")))


def check_fleet():
    """Alert per unreachable fleet host, and per host that stopped reporting.

    Two distinct failure modes: the probe ran and the host failed ('offline',
    fresh timestamp), or no probe result arrived at all (row older than
    FLEET_OFFLINE_S — the sampler or the link is dead).
    """
    fired = 0
    try:
        import fleet_monitor
        hosts = fleet_monitor.snapshot().get("hosts", [])
    except Exception:
        log.exception("fleet snapshot failed")
        return 0
    now = time.time()
    for h in hosts:
        try:
            name = h.get("name") or h.get("id") or "?"
            ident = str(h.get("id") or name)
            age = h.get("age_seconds")
            if h.get("status") == "offline":
                fired += bool(_fire(
                    "fleet-offline", ident,
                    f"远程主机 {name} 掉线",
                    f"采集探针无法连接主机 {name} (最近一次采集尝试失败)。"
                    f"请检查网络/中继与主机状态。",
                    urgency="normal", bucket_s=3600))
            elif age is not None and now - (h.get("timestamp") or 0) > FLEET_OFFLINE_S:
                fired += bool(_fire(
                    "fleet-stale", ident,
                    f"远程主机 {name} 停报 {round((now - h['timestamp']) / 60)} 分钟",
                    f"主机 {name} 已 {round((now - h['timestamp']) / 60)} 分钟没有新采集数据"
                    f" (最新状态: {h.get('status') or 'unknown'}), "
                    f"可能是采集服务停摆或链路中断。",
                    urgency="normal", bucket_s=3600))
        except Exception:
            log.exception("fleet check row failed")
    return fired


def _unit_active(unit):
    """True/False for a known unit, None when it cannot be determined."""
    try:
        r = subprocess.run(["systemctl", "is-active", unit],
                           capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    out = (r.stdout or "").strip()
    if out in ("active", "activating", "reloading"):
        return True
    if out in ("inactive", "failed", "deactivating"):
        return False
    return None  # unknown unit / no systemd: don't guess


def check_daemons():
    """Alert when a critical platform daemon is not active, and when the
    pressure signal itself has gone stale (the watcher-of-the-samplers check).

    Self-guarding: if the platform's own monitor (this daemon) were dead nothing
    would fire — but then no alert would arrive either, which is why the
    pressure-file freshness check matters (it covers pressure_writer, the one
    daemon every Pod's degradation logic depends on).
    """
    fired = 0
    for unit in WATCHED_UNITS:
        state = _unit_active(unit)
        if state is False:
            fired += bool(_fire(
                "daemon-down", unit,
                f"服务 {unit} 已停止",
                f"平台服务 {unit} 当前不是 active 状态, 相关能力已中断。"
                f"请用 systemctl status {unit} 查看并恢复。",
                urgency="high", bucket_s=3600))
    # pressure.json heartbeat
    try:
        with open(PRESSURE_FILE) as f:
            p = json.load(f)
        age = time.time() - float(p.get("ts") or 0)
    except Exception:
        age = None
    if age is None or age > PRESSURE_STALE_S:
        detail = ("压力信号文件缺失 (pressure_writer 未运行?)"
                  if age is None else f"压力信号已 {round(age)} 秒未刷新")
        fired += bool(_fire(
            "daemon-down", "pressure-file",
            "压力信号已中断",
            f"{detail}。Pod 侧降级与 priority_kill 驱逐都在盲跑, 请检查 "
            f"sse-pressure-writer 服务。",
            urgency="high", bucket_s=3600))
    return fired


def run_checks():
    """Run every host check. Returns the number of alerts claimed this pass.

    Never raises — a failing check is logged and skipped so the Pod monitor
    loop it is called from keeps running.
    """
    total = 0
    for fn in (check_disk, check_swap, check_gpu_temp, check_daemons, check_fleet):
        try:
            total += int(fn() or 0)
        except Exception:
            log.exception("host check %s failed", getattr(fn, "__name__", fn))
    return total


def _dry_fire(kind, ident, title, body, urgency="normal", bucket_s=BUCKET_S):
    """Report a would-be alert without claiming or pushing (--dry)."""
    print(f"[dry] {kind}/{ident} [{urgency}] {title} :: {body}")
    return False


if __name__ == "__main__":
    import sys
    if "--dry" in sys.argv[1:]:
        # Evaluate conditions without claiming/pushing. Assigns the module
        # global so the check functions (which look `_fire` up at call time)
        # pick it up.
        _fire = _dry_fire
    print("fired:", run_checks())
