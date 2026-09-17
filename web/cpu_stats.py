#!/usr/bin/env python3
"""CPU statistics for the admin dashboard.

Uses only the Python standard library (os, time, subprocess) — no psutil.
Designed to never raise: on any failure it returns a dict with an ``error``
key and sensible defaults so the template can still render.
"""
import os
import subprocess
import time

import kvcache

import siteconf

NS = siteconf.GROUP_NS
# k3s metrics-server is installed; top needs a moment to warm up, but we just
# call it and tolerate failure.


def _cpu_jiffies():
    """Return (total, busy) jiffies from the first line of /proc/stat, or None."""
    try:
        with open("/proc/stat") as f:
            first = f.readline()
        # first line: "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
        parts = first.split()
        if not parts or parts[0] != "cpu":
            return None
        vals = [int(x) for x in parts[1:]]
        if not vals:
            return None
        # idle = idle + iowait (indices 3, 4); busy = total - idle
        total = sum(vals)
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        busy = total - idle
        return (total, busy)
    except Exception:
        return None


def _usage_pct():
    """Overall CPU busy % sampled over ~0.5s. Returns float, 0.0 on failure."""
    a = _cpu_jiffies()
    if a is None:
        return 0.0
    time.sleep(0.5)
    b = _cpu_jiffies()
    if b is None:
        return 0.0
    d_total = b[0] - a[0]
    d_busy = b[1] - a[1]
    if d_total <= 0:
        return 0.0
    return round((d_busy / d_total) * 100.0, 1)


def _loadavg():
    """Return (load1, load5) from /proc/loadavg, or (0.0, 0.0) on failure."""
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
        return (float(parts[0]), float(parts[1]))
    except Exception:
        return (0.0, 0.0)


def _cores():
    """Return CPU core count via os.cpu_count() with nproc fallback."""
    try:
        c = os.cpu_count()
        if c:
            return int(c)
    except Exception:
        pass
    try:
        r = subprocess.run(["nproc"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return int(r.stdout.strip())
    except Exception:
        pass
    return 0


def _group_name_from_pod(pod):
    """Convert 'group-foo-bar-<rshash>-<podhash>' -> 'foo-bar'.

    Pod names from a Deployment are ``group-<name>-<replicaset-hash>-<pod-hash>``:
    drop the leading ``group`` segment and the **two** trailing hash segments
    (ReplicaSet hash + pod hash), join the remainder. ``name`` may itself contain
    dashes (e.g. tx-gpu-ai-train). Falls back to the raw pod name on unexpected
    shape.
    """
    parts = pod.split("-")
    if len(parts) >= 4 and parts[0] == "group":
        return "-".join(parts[1:-2])
    return pod


def _per_group_raw():
    """Raw kubectl top pod call. Returns list of {name, cpu, mem}."""
    out = []
    try:
        r = subprocess.run(
            ["kubectl", "-n", NS, "top", "pod", "--no-headers"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            return []
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            cols = line.split()
            if len(cols) < 3:
                continue
            pod, cpu, mem = cols[0], cols[1], cols[2]
            out.append({
                "name": _group_name_from_pod(pod),
                "cpu": cpu,
                "mem": mem,
            })
    except Exception:
        return []
    return out


def _per_group():
    """Return list of {name, cpu, mem} for group pods via kubectl top.
    Cached in Redis for 10s.

    Empty list on any failure or when no pods exist.
    """
    return kvcache.get_or_compute("k3s:top_pod", _per_group_raw, ttl=10)


def _cpu_stats_raw():
    """Raw computation of CPU stats (calls /proc + kubectl)."""
    cores = _cores()
    load1, load5 = _loadavg()
    usage = _usage_pct()
    per_group = _per_group()
    return {
        "cores": cores,
        "load1": load1,
        "load5": load5,
        "usage_pct": usage,
        "per_group": per_group,
    }


def cpu_stats():
    """Return a dict for template rendering.

    Shape::
        {"cores": int, "load1": float, "load5": float,
         "usage_pct": float, "per_group": [{"name","cpu","mem"}, ...]}

    Cached in Redis for 10s. Never raises; on error includes an ``error`` key.
    """
    cached = kvcache.get("host:cpu")
    if cached is not None:
        return cached
    try:
        result = _cpu_stats_raw()
        kvcache.set("host:cpu", result, ttl=10)
        return result
    except Exception as e:
        return {
            "cores": 0,
            "load1": 0.0,
            "load5": 0.0,
            "usage_pct": 0.0,
            "per_group": [],
            "error": str(e),
        }
