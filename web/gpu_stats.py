#!/usr/bin/env python3
"""GPU statistics for the admin dashboard.

Calls ``nvidia-smi`` to collect per-GPU metrics and joins them with the
group-to-GPU mapping from :mod:`groups`.  The result is a plain dict ready
for template rendering.  This module never raises — any failure (missing
binary, parse error, …) yields ``{"gpus": [], "count": 0, "error": ...}``.

It also attributes *live* per-process usage back to Pods::

    nvidia-smi --query-compute-apps   → per-process VRAM (MiB)
    nvidia-smi pmon                   → per-process SM utilisation (%)
    /proc/<pid>/cgroup                → PID → Pod UID → group name

Host-side processes (Xorg, mps-server, the local LLM engine, …) live outside
``kubepods*`` cgroups and are skipped; the frontend shows them as the
unattributed remainder on each card.
"""
import re
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


# Matches the pod slice in a cgroup path for *every* QoS class, e.g.
#   .../kubepods-burstable.slice/kubepods-burstable-pod<uid>.slice/...scope
#   .../kubepods.slice/kubepods-pod<uid>.slice/...scope  (guaranteed)
# The old pattern hard-coded "kubepods-pod", which never matches the
# burstable-besteffort-prefixed paths that all pods on this node use.
_CGROUP_POD_RE = re.compile(r"kubepods[^/]*?-pod([0-9a-f_]+)\.slice")


def _pid_group(pid_s, uids):
    """Resolve a PID's group name via /proc/<pid>/cgroup; '' if not a pod."""
    try:
        cg = open(f"/proc/{pid_s}/cgroup").read()
    except OSError:
        return ""
    m = _CGROUP_POD_RE.search(cg)
    if not m:
        return ""  # host process (Xorg, mps-server, local engine, …)
    return uids.get(m.group(1).replace("_", "-"), "")


def _compute_apps():
    """Return ``[(gpu_index, pid_str, mem_mib), ...]`` from compute apps."""
    r = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=10,
    )
    uuid_idx = {}
    for line in r.stdout.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) == 2:
            try:
                uuid_idx[parts[1]] = int(parts[0])
            except ValueError:
                pass
    r = subprocess.run(
        ["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,used_memory",
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=10,
    )
    apps = []
    for line in r.stdout.splitlines():
        parts = [x.strip() for x in line.split(",")]
        if len(parts) < 3:
            continue
        idx = uuid_idx.get(parts[0])
        if idx is None:
            continue
        try:
            mem = int(float(parts[-1]))
        except ValueError:
            continue
        apps.append((idx, parts[1], mem))
    return apps


def _pmon_sm():
    """Return ``{(gpu_index, pid_str): sm_pct}`` from one pmon sample.

    pmon's columns are fixed: ``gpu pid type sm% mem% enc% dec% jpg% ofa% …``,
    so ``sm`` is field 3 of each data row. It prints ``-`` for a process with
    no activity in the sampling interval — those are skipped. Best-effort:
    returns ``{}`` on any failure.
    """
    out = {}
    try:
        r = subprocess.run(
            ["nvidia-smi", "pmon", "-c", "1"],
            capture_output=True, text=True, timeout=10,
        )
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 4:
                continue
            try:
                idx = int(parts[0])
            except ValueError:
                continue
            pid, sm = parts[1], parts[3]
            if not pid.isdigit() or sm in ("-", ""):
                continue
            try:
                out[(idx, pid)] = float(sm)
            except ValueError:
                continue
    except Exception:
        return {}
    return out


def per_pod_breakdown():
    """Per-group live GPU attribution: ``{group: {gpu_index: {"mem", "util"}}}``.

    ``mem`` is MiB of VRAM, ``util`` is summed SM utilisation % across the
    group's processes on that card (it may exceed 100 when several processes
    are busy — the frontend reads it as a relative share). Cached in kvcache
    for 10s; returns ``{}`` on any failure.
    """
    cached = kvcache.get("host:gpu-perpod-bd")
    if cached is not None:
        return cached
    out = {}
    try:
        apps = _compute_apps()
        sm = _pmon_sm()
        uids = _uid_to_group()
        for idx, pid, mem in apps:
            group = _pid_group(pid, uids)
            if not group:
                continue
            cell = out.setdefault(group, {}).setdefault(
                idx, {"mem": 0, "util": 0.0}
            )
            cell["mem"] += mem
            cell["util"] += sm.get((idx, pid), 0.0)
    except Exception:
        return {}
    kvcache.set("host:gpu-perpod-bd", out, ttl=10)
    return out


def per_pod_usage():
    """Per-group GPU memory attribution: ``{group: {gpu_index: MiB}}``.

    Backward-compatible memory-only view of :func:`per_pod_breakdown`; used by
    the Pod detail API for a pod's own VRAM on each of its cards.
    """
    bd = per_pod_breakdown()
    return {
        group: {idx: cell["mem"] for idx, cell in per_gpu.items()}
        for group, per_gpu in bd.items()
    }


def _gpu_stats_raw():
    """Raw GPU stats computation (nvidia-smi + group mapping + pod usage)."""
    raw = _query_gpus()
    try:
        overview = groups.gpu_overview()
    except Exception:
        overview = {}
    try:
        breakdown = per_pod_breakdown()
    except Exception:
        breakdown = {}
    # invert {group: {gpu: {...}}} → {gpu: [{name, mem, util}, ...]}
    by_gpu = {}
    for group, per_gpu in breakdown.items():
        for idx, cell in per_gpu.items():
            by_gpu.setdefault(idx, []).append(
                {"name": group, "mem": cell["mem"], "util": round(cell["util"], 1)}
            )
    gpus = []
    for g in raw:
        entry = dict(g)
        entry["groups"] = list(overview.get(g["index"], []))
        pods = by_gpu.get(g["index"], [])
        pods.sort(key=lambda p: p["mem"], reverse=True)
        entry["pods"] = pods
        gpus.append(entry)
    return {"gpus": gpus, "count": len(gpus)}


def gpu_stats():
    """Build the GPU stats dict for template rendering.
    Cached in Redis for 10s.

    Shape on success::

        {"gpus": [{"index", "name", "util", "mem_used", "mem_total",
                   "temp", "power", "power_limit", "groups": [...],
                   "pods": [{"name", "mem", "util"}, ...]}, ...],
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
