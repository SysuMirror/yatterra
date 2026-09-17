#!/usr/bin/env python3
"""Host health for the admin dashboard.

Collects host-level telemetry: disk usage, memory, swap, uptime, load,
kernel/OS info, k3s node status, frpc proxy status, nvidia driver/GPU
count, and the number of groups.

Uses only the Python standard library (os, shutil, subprocess, json,
socket, time) plus the local :mod:`groups` module — no psutil, no new
external packages.  This module never raises: every sub-collector is
wrapped so that on any failure it yields a dict with an ``error`` key
and sensible defaults, and :func:`host_health` itself returns a full
dict even if every collector failed.
"""
import json
import os
import shutil
import socket
import subprocess

import groups
import kvcache

# frpc admin API (matches groups.FRPC_ADMIN but read locally to avoid coupling)
import siteconf

_FRPC_URL = siteconf.FRPC_ADMIN_URL + "/api/status"
_FRPC_USER = siteconf.FRPC_ADMIN_USER
_FRPC_PASS = siteconf.FRPC_ADMIN_PASS

# mount points to report disk usage for
_DISK_MOUNTS = siteconf.DISK_MOUNTS


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _run(cmd, timeout=15):
    """Run a command, return CompletedProcess. Raises on timeout/missing binary."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _human_bytes(num):
    """Format a byte count as a short human-readable string (e.g. '1.2 GiB')."""
    try:
        n = float(num)
    except Exception:
        return "?"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB", "PiB"):
        if abs(n) < 1024.0 or unit == "PiB":
            if unit == "B":
                return f"{int(n)} {unit}"
            return f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} PiB"


def _human_uptime(seconds):
    """Format seconds as 'Xd Yh Zm' (days/hours/minutes)."""
    try:
        s = int(float(seconds))
    except Exception:
        return "?"
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, _ = divmod(s, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


# --------------------------------------------------------------------------- #
# collectors — each returns a dict, never raises
# --------------------------------------------------------------------------- #
def _disk():
    """Disk usage for each mount in _DISK_MOUNTS."""
    out = []
    for mnt in _DISK_MOUNTS:
        entry = {"mount": mnt}
        try:
            u = shutil.disk_usage(mnt)
            total = int(u.total)
            used = int(u.used)
            avail = int(u.free)
            used_pct = round((used / total) * 100.0, 1) if total else 0.0
            entry.update({
                "total": total,
                "used": used,
                "avail": avail,
                "used_pct": used_pct,
                "total_h": _human_bytes(total),
                "used_h": _human_bytes(used),
                "avail_h": _human_bytes(avail),
            })
        except Exception as e:
            entry["error"] = str(e)
        out.append(entry)
    return out


def _mem():
    """Memory info from /proc/meminfo (values in bytes)."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    try:
                        info[parts[0][:-1]] = int(parts[1]) * 1024  # kB -> B
                    except Exception:
                        pass
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", 0)
        free = info.get("MemFree", 0)
        used = max(total - avail, 0)
        used_pct = round((used / total) * 100.0, 1) if total else 0.0
        return {
            "total": total,
            "used": used,
            "avail": avail,
            "free": free,
            "used_pct": used_pct,
            "total_h": _human_bytes(total),
            "used_h": _human_bytes(used),
            "avail_h": _human_bytes(avail),
        }
    except Exception as e:
        return {"error": str(e)}


def _swap():
    """Swap info from /proc/meminfo (values in bytes)."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0].endswith(":"):
                    try:
                        info[parts[0][:-1]] = int(parts[1]) * 1024
                    except Exception:
                        pass
        total = info.get("SwapTotal", 0)
        free = info.get("SwapFree", 0)
        used = max(total - free, 0)
        used_pct = round((used / total) * 100.0, 1) if total else 0.0
        return {
            "total": total,
            "used": used,
            "free": free,
            "used_pct": used_pct,
            "total_h": _human_bytes(total),
            "used_h": _human_bytes(used),
        }
    except Exception as e:
        return {"error": str(e)}


def _uptime():
    """Uptime from /proc/uptime: {seconds, human}."""
    try:
        with open("/proc/uptime") as f:
            parts = f.read().split()
        secs = float(parts[0])
        return {"seconds": round(secs, 1), "human": _human_uptime(secs)}
    except Exception as e:
        return {"error": str(e)}


def _load():
    """Load average from /proc/loadavg: {load1, load5, load15}."""
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
        return {
            "load1": float(parts[0]),
            "load5": float(parts[1]),
            "load15": float(parts[2]),
        }
    except Exception as e:
        return {"error": str(e)}


def _cpu():
    """CPU core count + load averages: {cores, load1, load5, load15}.

    ``cores`` is the usable CPU count (os.cpu_count()). Load is merged in so
    consumers expecting ``cpu.load1`` (frontend, insight) find it here too.
    """
    out = {}
    try:
        out["cores"] = os.cpu_count() or 0
    except Exception as e:
        out["cores"] = 0
        out["error"] = str(e)
    out.update(_load())
    return out


def _pods():
    """Pod count in the group namespace: {count, running}."""
    try:
        r = _run(["kubectl", "-n", siteconf.GROUP_NS, "get", "pods", "-o", "json"], timeout=15)
        if r.returncode != 0:
            return {"count": 0, "running": 0,
                    "error": (r.stderr or "kubectl failed").strip()}
        items = json.loads(r.stdout).get("items", [])
        running = sum(1 for it in items
                      if (it.get("status") or {}).get("phase") == "Running")
        return {"count": len(items), "running": running}
    except Exception as e:
        return {"count": 0, "running": 0, "error": str(e)}


def _kernel_os():
    """Kernel + OS info via os.uname and /etc/os-release PRETTY_NAME."""
    out = {}
    try:
        u = os.uname()
        out.update({
            "sysname": u.sysname,
            "release": u.release,
            "machine": u.machine,
            "nodename": u.nodename,
        })
    except Exception as e:
        out["uname_error"] = str(e)
    try:
        pretty = None
        with open("/etc/os-release") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    pretty = line.split("=", 1)[1].strip().strip('"')
                    break
        out["os_pretty"] = pretty or ""
    except Exception as e:
        out["os_error"] = str(e)
    return out


def _k3s():
    """k3s node status via kubectl get node -o json.

    Returns {nodes: [{name, ready, version, conditions: {KubeletReady,...}}],
             count, error?}.
    """
    try:
        r = _run(["kubectl", "get", "node", "-o", "json"], timeout=15)
        if r.returncode != 0:
            return {"nodes": [], "count": 0,
                    "error": (r.stderr or "kubectl failed").strip()}
        data = json.loads(r.stdout)
        items = data.get("items", [])
        nodes = []
        for it in items:
            name = it.get("metadata", {}).get("name", "")
            conds_raw = (it.get("status", {})
                         .get("conditions", []))
            conds = {}
            ready = "Unknown"
            for c in conds_raw:
                ctype = c.get("type", "")
                status = c.get("status", "")
                conds[ctype] = status
                if ctype == "Ready":
                    ready = "True" if status == "True" else status
            version = (it.get("status", {})
                       .get("nodeInfo", {})
                       .get("kubeletVersion", ""))
            nodes.append({
                "name": name,
                "ready": ready,
                "version": version,
                "conditions": conds,
            })
        return {"nodes": nodes, "count": len(nodes)}
    except Exception as e:
        return {"nodes": [], "count": 0, "error": str(e)}


def _frpc():
    """frpc proxy status via its admin API.

    Counts total proxies and how many are 'running'.  Uses curl with
    basic auth (stdlib urllib could also work, but curl is already a
    dependency elsewhere and avoids auth header plumbing).
    """
    try:
        r = _run(
            ["curl", "-s", "-m", "5",
             "-u", f"{_FRPC_USER}:{_FRPC_PASS}", _FRPC_URL],
            timeout=8,
        )
        if r.returncode != 0:
            return {"total": 0, "running": 0,
                    "error": (r.stderr or "curl failed").strip()}
        data = json.loads(r.stdout)
        total = 0
        running = 0
        # API shape: {"tcp":[{name,status,...},...], "udp":[...], ...}
        for ptype, proxies in (data.items() if isinstance(data, dict) else []):
            if not isinstance(proxies, list):
                continue
            for p in proxies:
                total += 1
                if str(p.get("status", "")).lower() == "running":
                    running += 1
        return {"total": total, "running": running}
    except Exception as e:
        return {"total": 0, "running": 0, "error": str(e)}


def _nvidia():
    """Nvidia driver version, GPU count, and per-GPU detail via nvidia-smi."""
    out = {}
    try:
        r = _run(
            ["nvidia-smi", "--query-gpu=driver_version",
             "--format=csv,noheader"],
            timeout=10,
        )
        if r.returncode != 0:
            out["error"] = (r.stderr or "nvidia-smi failed").strip()
            out["driver_version"] = ""
            out["count"] = 0
            out["gpus"] = []
            return out
        versions = []
        for line in r.stdout.splitlines():
            line = line.strip()
            if line:
                versions.append(line)
        out["count"] = len(versions)
        out["driver_version"] = versions[0] if versions else ""
    except Exception as e:
        out["error"] = str(e)
        out["driver_version"] = out.get("driver_version", "")
        out["count"] = out.get("count", 0)
    # per-GPU detail (util/mem/temp/power) — reuse gpu_stats, never fatal
    try:
        import gpu_stats
        out["gpus"] = (gpu_stats.gpu_stats() or {}).get("gpus", [])
    except Exception:
        out.setdefault("gpus", [])
    return out


def _groups_count():
    """Number of groups from groups.load_state()."""
    try:
        state = groups.load_state()
        return {"count": len(state.get("groups", {}))}
    except Exception as e:
        return {"count": 0, "error": str(e)}


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #
def _host_health_raw():
    """Raw host health computation (all sub-collectors)."""
    result = {}
    for key, fn in (
        ("disk", _disk),
        ("mem", _mem),
        ("swap", _swap),
        ("uptime", _uptime),
        ("load", _load),
        ("cpu", _cpu),
        ("pods", _pods),
        ("kernel_os", _kernel_os),
        ("k3s", _k3s),
        ("frpc", _frpc),
        ("nvidia", _nvidia),
        ("groups_count", _groups_count),
    ):
        try:
            result[key] = fn()
        except Exception as e:
            result[key] = {"error": str(e)}
    # top-level convenience aliases (frontend/insight read these directly)
    ko = result.get("kernel_os") or {}
    result["hostname"] = ko.get("nodename", "")
    result["os"] = ko.get("os_pretty", "")
    result["kernel"] = ko.get("release", "")
    return result


def host_health():
    """Return a dict of host health metrics for template rendering.
    Cached in Redis for 30s.

    Shape (every sub-dict may carry an ``error`` key on partial failure)::

        {"disk": [...], "mem": {...}, "swap": {...}, "uptime": {...},
         "load": {...}, "kernel_os": {...}, "k3s": {...},
         "frpc": {...}, "nvidia": {...}, "groups_count": {...}}

    Never raises.
    """
    cached = kvcache.get("host:health")
    if cached is not None:
        return cached
    result = _host_health_raw()
    kvcache.set("host:health", result, ttl=30)
    return result
