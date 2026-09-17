#!/usr/bin/env python3
"""GPU statistics for the admin dashboard.

Calls ``nvidia-smi`` to collect per-GPU metrics and joins them with the
group-to-GPU mapping from :mod:`groups`.  The result is a plain dict ready
for template rendering.  This module never raises — any failure (missing
binary, parse error, …) yields ``{"gpus": [], "count": 0, "error": ...}``.
"""
import subprocess

import groups
import kvcache

_NVIDIA_SMI = (
    "nvidia-smi",
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,"
    "temperature.gpu,power.draw,power.limit",
    "--format=csv,noheader,nounits",
)


def _query_gpus():
    """Return a list of raw per-GPU dicts, or raise on failure."""
    out = subprocess.run(
        _NVIDIA_SMI, capture_output=True, text=True, timeout=10
    )
    if out.returncode != 0:
        raise RuntimeError(
            (out.stderr or "nvidia-smi failed").strip() or "nvidia-smi failed"
        )
    gpus = []
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            raise ValueError(f"unexpected nvidia-smi line: {line!r}")
        idx = int(parts[0])
        name = parts[1]
        util = int(parts[2])
        mem_used = int(parts[3])
        mem_total = int(parts[4])
        temp = int(parts[5])
        power = float(parts[6])
        power_limit = float(parts[7])
        gpus.append(
            {
                "index": idx,
                "name": name,
                "util": util,
                "mem_used": mem_used,
                "mem_total": mem_total,
                "temp": temp,
                "power": power,
                "power_limit": power_limit,
            }
        )
    if not gpus:
        raise RuntimeError("nvidia-smi returned no GPUs")
    return gpus


_pod_map_cache = {"ts": 0.0, "map": {}}


def _uid_to_group():
    """Map pod UID -> group name via one kubectl call (cached 30s).

    Pod names look like group-<name>-<rs>-<rand>; group names may
    themselves contain hyphens, so match the longest group-name prefix
    followed by '-'.
    """
    import time
    now = time.time()
    if now - _pod_map_cache["ts"] < 30:
        return _pod_map_cache["map"]
    m = {}
    try:
        r = groups.kubectl(
            "get", "pods", "--no-headers",
            "-o", "custom-columns=UID:.metadata.uid,NAME:.metadata.name",
            check=False,
        )
        names = set(groups.load_state()["groups"])
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                parts = line.split()
                if len(parts) < 2 or not parts[1].startswith("group-"):
                    continue
                uid, rest = parts[0], parts[1][len("group-"):]
                best = None
                for gname in names:
                    if rest.startswith(gname + "-") and (
                        best is None or len(gname) > len(best)
                    ):
                        best = gname
                if best:
                    m[uid] = best
    except Exception:
        pass
    _pod_map_cache["map"] = m
    _pod_map_cache["ts"] = now
    return m


def per_pod_usage():
    """Per-group GPU memory attribution: {group: {gpu_index: MiB}}.

    Walks nvidia-smi compute apps (under MPS each client process is
    listed individually with its own memory), maps each PID to its pod
    via /proc/<pid>/cgroup, and sums per group. Host-side processes
    (mps-server etc.) have no kubepods cgroup and are skipped.
    Cached in kvcache for 10s; returns {} on any failure.
    """
    cached = kvcache.get("host:gpu-perpod")
    if cached is not None:
        return cached
    out = {}
    try:
        import re as _re
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        uuid_idx = {}
        for line in r.stdout.splitlines():
            parts = [x.strip() for x in line.split(",")]
            if len(parts) == 2:
                uuid_idx[parts[1]] = int(parts[0])
        r = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        uids = _uid_to_group()
        for line in r.stdout.splitlines():
            parts = [x.strip() for x in line.split(",")]
            if len(parts) < 3:
                continue
            uuid, pid_s, mem_s = parts[0], parts[1], parts[-1]
            try:
                mem = int(float(mem_s))
            except ValueError:
                continue
            idx = uuid_idx.get(uuid)
            if idx is None:
                continue
            try:
                cg = open(f"/proc/{pid_s}/cgroup").read()
            except OSError:
                continue
            m = _re.search(r"kubepods-pod([0-9a-f_]+)\.slice", cg)
            if not m:
                continue  # host process (e.g. mps-server)
            uid = m.group(1).replace("_", "-")
            group = uids.get(uid)
            if group:
                out.setdefault(group, {}).setdefault(idx, 0)
                out[group][idx] += mem
    except Exception:
        return {}
    kvcache.set("host:gpu-perpod", out, ttl=10)
    return out


def _gpu_stats_raw():
    """Raw GPU stats computation (nvidia-smi + group mapping)."""
    raw = _query_gpus()
    try:
        overview = groups.gpu_overview()
    except Exception:
        overview = {}
    gpus = []
    for g in raw:
        entry = dict(g)
        entry["groups"] = list(overview.get(g["index"], []))
        gpus.append(entry)
    return {"gpus": gpus, "count": len(gpus)}


def gpu_stats():
    """Build the GPU stats dict for template rendering.
    Cached in Redis for 10s.

    Shape on success::

        {"gpus": [{"index", "name", "util", "mem_used", "mem_total",
                   "temp", "power", "power_limit", "groups": [...]}, ...],
         "count": int}

    On any error::

        {"gpus": [], "count": 0, "error": "..."}
    """
    cached = kvcache.get("host:gpu")
    if cached is not None:
        return cached
    try:
        result = _gpu_stats_raw()
        kvcache.set("host:gpu", result, ttl=10)
        return result
    except Exception as e:
        return {"gpus": [], "count": 0, "error": str(e)}
