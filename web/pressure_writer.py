#!/usr/bin/env python3
"""Pressure signal writer for env-aware applications.

Why this exists
---------------
Pod environment variables are baked into the process at container start and
immutable at runtime — changing them requires a `kubectl rollout restart`
(see groups.set_env), which recreates the Pod and loses in-memory state.
That is fine for slow, per-deploy config (PRIORITY, MINIO_*, SDPY_*) but
unusable for second-by-second pressure signals.

This writer publishes host pressure (cpu / gpu / mem / bw) to a file on the
shared hostPath that every group Pod already mounts readOnly at /shared:

    terra (root, host) writes  /mnt/sdb/shared/pressure/pressure.json
    app (in pod) reads         /shared/pressure/pressure.json

hostPath is the same kernel inode on both sides, so updates are visible
instantly — no rollout, no kubectl exec, no kubelet sync lag (unlike
ConfigMap). One host write fans out to every pod.

Standalone
----------
Does NOT import yatterra core (groups/scheduler/...). Collects directly from
/proc and nvidia-smi so it can't break the panel or the gpu_loop. Runs as
root only because /mnt/sdb/shared is root-owned; the file it writes is
world-readable so pods (uid 1000) can read it.

Atomic writes: tmp file + os.replace, so apps never observe a half-written
JSON. Never raises: a failed collector yields null for that metric.

Run it
------
    # one-shot (writes once and exits)
    python3 /opt/yatterra/web/pressure_writer.py --once

    # loop (default, every 2s) — run as a systemd unit like gpu_loop
    python3 /opt/yatterra/web/pressure_writer.py

Suggested unit /etc/systemd/system/sse-pressure-writer.service:
    [Unit]
    Description=yatterra pressure signal writer
    After=network.target
    [Service]
    ExecStart=/usr/bin/python3 /opt/yatterra/web/pressure_writer.py
    Restart=always
    User=root
    [Install]
    WantedBy=multi-user.target

Output contract (what apps read)
--------------------------------
/shared/pressure/pressure.json:
{
  "cpu": 0.82,            // 0..1 overall busy fraction
  "gpu": 0.41,            // 0..1 avg across GPUs (util); null if no nvidia-smi
  "gpu_mem": 0.55,        // 0..1 avg gpu memory fraction
  "mem": 0.55,            // 0..1 host memory used / total
  "bw": 0.93,             // 0..1 (rx+tx bytes/s) / link_capacity
  "bw_rx_bps": 93000000,  // raw bytes/s inbound
  "bw_tx_bps": 12000000,  // raw bytes/s outbound
  "level": {              // discrete classification for easy app branching
    "cpu": "high", "gpu": "med", "mem": "med", "bw": "high"
  },
  "ts": 1724500000.0      // epoch seconds (time.time())
}
App logic example: if level["bw"] == "high": serve low-res mode.

Tune via env: PRESSURE_POLL_S, PRESSURE_LINK_BPS (default 1 Gbit/s),
PRESSURE_HIGH (default 0.8), PRESSURE_MED (default 0.5).
"""
import json
import os
import subprocess
import time

import siteconf

OUT_DIR = siteconf.PRESSURE_DIR
OUT_FILE = os.path.join(OUT_DIR, "pressure.json")
POLL_S = float(os.environ.get("PRESSURE_POLL_S", "2"))
# Link capacity in bytes/s for bw fraction. Default 1 Gbit/s = 125_000_000 B/s.
LINK_BPS = float(os.environ.get("PRESSURE_LINK_BPS", "125000000"))
THRESH_HIGH = float(os.environ.get("PRESSURE_HIGH", "0.8"))
THRESH_MED = float(os.environ.get("PRESSURE_MED", "0.5"))


def _level(frac):
    if frac is None:
        return None
    if frac >= THRESH_HIGH:
        return "high"
    if frac >= THRESH_MED:
        return "med"
    return "low"


# --- collectors (each returns a number or None, never raises) -----------------

def _cpu_jiffies():
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
        if not parts or parts[0] != "cpu":
            return None
        vals = [int(x) for x in parts[1:]]
        total = sum(vals)
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return (total, total - idle)
    except Exception:
        return None


def cpu_frac(sample_s=0.3):
    a = _cpu_jiffies()
    if a is None:
        return None
    time.sleep(sample_s)
    b = _cpu_jiffies()
    if b is None:
        return None
    dt = b[0] - a[0]
    db = b[1] - a[1]
    if dt <= 0:
        return None
    return round(db / dt, 3)


def mem_frac():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0]) * 1024  # KiB -> bytes
        total = info.get("MemTotal")
        avail = info.get("MemAvailable")
        if not total or avail is None:
            return None
        return round(1.0 - avail / total, 3)
    except Exception:
        return None


def gpu_frac():
    """Return (util_frac, mem_frac) averaged across GPUs, or (None, None)."""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            return (None, None)
        utils, mems = [], []
        for line in out.stdout.splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) < 3:
                continue
            utils.append(int(p[0]) / 100.0)
            mt = int(p[2])
            if mt > 0:
                mems.append(int(p[1]) / mt)
        if not utils:
            return (None, None)
        return (round(sum(utils) / len(utils), 3),
                round(sum(mems) / len(mems), 3) if mems else None)
    except Exception:
        return (None, None)


def _uplink_ifaces():
    """Interfaces that actually carry off-host traffic: the default-route
    device(s).

    Summing *every* non-lo interface double- or triple-counts pod traffic — a
    packet crossing veth -> cni0 -> eno1 is counted once per hop, and overlay
    (flannel.1) / tailscale0 add more. On this host that inflated bw ~2-3x and
    caused spurious evictions (e.g. rag stopped with hit=['bw'] while the real
    uplink was idle). Count the uplink only.

    Falls back to physical NICs (/sys/class/net/<if>/device) if /proc/net/route
    is unreadable, and to None (=> all non-lo) as a last resort.
    """
    ifaces = set()
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                cols = line.split()
                # Iface Destination Gateway ... ; default route = 00000000
                if len(cols) >= 2 and cols[1] == "00000000":
                    ifaces.add(cols[0])
    except Exception:
        pass
    if ifaces:
        return ifaces
    try:
        for n in os.listdir("/sys/class/net"):
            if n != "lo" and os.path.exists(f"/sys/class/net/{n}/device"):
                ifaces.add(n)
    except Exception:
        pass
    return ifaces or None


def _net_bytes():
    """Sum rx/tx bytes across the uplink interface(s) from /proc/net/dev."""
    try:
        ifaces = _uplink_ifaces()
        rx = tx = 0
        with open("/proc/net/dev") as f:
            for line in f:
                if ":" not in line:
                    continue
                name, rest = line.split(":", 1)
                name = name.strip()
                if name == "lo":
                    continue
                if ifaces is not None and name not in ifaces:
                    continue
                cols = rest.split()
                rx += int(cols[0])
                tx += int(cols[8])
        return (rx, tx)
    except Exception:
        return None


def bw_frac(sample_s=1.0):
    """Return (frac, rx_bps, tx_bps) or (None, None, None)."""
    a = _net_bytes()
    if a is None:
        return (None, None, None)
    time.sleep(sample_s)
    b = _net_bytes()
    if b is None:
        return (None, None, None)
    drx = b[0] - a[0]
    dtx = b[1] - a[1]
    rx_bps = drx / sample_s
    tx_bps = dtx / sample_s
    frac = round((rx_bps + tx_bps) / LINK_BPS, 3) if LINK_BPS > 0 else None
    return (frac, int(rx_bps), int(tx_bps))


# --- writer -------------------------------------------------------------------

def collect():
    """Collect all metrics. cpu/bw sample internally; gpu/mem are instant."""
    cpu = cpu_frac()
    mem = mem_frac()
    g_util, g_mem = gpu_frac()
    bw, rx_bps, tx_bps = bw_frac()
    return {
        "cpu": cpu,
        "gpu": g_util,
        "gpu_mem": g_mem,
        "mem": mem,
        "bw": bw,
        "bw_rx_bps": rx_bps,
        "bw_tx_bps": tx_bps,
        "level": {
            "cpu": _level(cpu),
            "gpu": _level(g_util),
            "mem": _level(mem),
            "bw": _level(bw),
        },
        "ts": round(time.time(), 3),
    }


def write_once():
    payload = collect()
    _notify_level_switch(payload)
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        tmp = OUT_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
            f.write("\n")
        os.replace(tmp, OUT_FILE)
        # world-readable so uid-1000 pods can read
        try:
            os.chmod(OUT_FILE, 0o644)
        except Exception:
            pass
    except Exception as e:
        # never let a write error kill the loop
        import logutil
        logutil.write(
            siteconf.path("pressure_writer.log"),
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] write error: {e!r}\n",
        )
    return payload


# --- 压力降级通知(kind='pressure') -------------------------------------------
# 层级切换点: 任一指标(cpu/gpu/mem/bw)从非 high 跃迁到 high 即视为触发降级
# (terra→sdpy→app 三层降级由 app 侧按 level 字段执行, 这里只报切换边沿)。
# 刻意不 import cert_alerts(避免在独立进程里重复拉起检查线程), 本地实现
# 同款 _claim_alert 去重 + send_to_users(admin) 直发; 全部 lazy + 吞异常,
# 通知失败绝不影响压力信号写入。
_prev_levels = {}


def _notify_level_switch(payload):
    try:
        levels = (payload or {}).get("level") or {}
        for metric, lvl in levels.items():
            prev = _prev_levels.get(metric)
            _prev_levels[metric] = lvl
            if lvl != "high" or prev == "high" or prev is None:
                continue  # 只报进入 high 的边沿(首轮静默基线)
            _push_pressure_alert(metric)
    except Exception:
        pass


def _push_pressure_alert(metric):
    try:
        import pwa_alerts
        from api.push import send_to_users
        import users
        admins = [u["username"] for u in users.list_users()
                  if (u.get("role") or "") in ("super", "admin")
                  or users.has_perm(u, "infra.host")]
        if not admins:
            return
        bucket = int(time.time() // 600)  # 10 分钟桶防风暴
        event_key = f"pressure:{metric}:{bucket}"
        pwa_alerts.init_db()
        # 借用内部 _claim_alert: at-most-once 去重 + 通知中心留痕(同 cert_alerts 取舍)
        # recipients=admins: 中心可见性与实际推送目标一致(非 admin 不可见)
        if not pwa_alerts._claim_alert(event_key, "pressure", "platform",
                                       {"title": "主机压力升高", "body": "",
                                        "url": "/infra/host"}, admins):
            return
        send_to_users(admins, {
            "title": "主机压力升高",
            "body": f"主机 {metric} 压力升至 high, 已触发降级信号"
                    f"(阈值 {THRESH_HIGH}), 低优先级任务可能被驱逐。",
            "url": "/infra/host", "type": "pressure",
            "event_key": event_key, "urgency": "high"})
    except Exception:
        pass


def main():
    import sys
    once = "--once" in sys.argv[1:]
    if once:
        write_once()
        return
    while True:
        write_once()
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
