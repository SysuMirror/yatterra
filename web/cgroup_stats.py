#!/usr/bin/env python3
"""Instantaneous per-group CPU/memory sampling straight from cgroup v2.

Background loops (``req_loop``) previously sized requests from ``kubectl top
pod``, which reports a 1-minute rate computed by metrics-server — too laggy to
react to a burst.  cgroup v2 exposes the raw counters the kubelet itself reads,
so we can compute a true instantaneous rate between two consecutive calls.

Public contract (other modules depend on it verbatim):

    sample_groups() -> {group_name: (cpu_cores, mem_gi)}
    available()     -> bool   # cgroup v2 pod accounting is readable

Both never raise: ``sample_groups`` returns ``{}`` and ``available`` returns
``False`` on any failure.  stdlib only.
"""
import json
import os
import subprocess
import time

# siteconf only decides which namespace to query; a broken/missing one must not
# break the import (mirrors the /srv fallback discipline elsewhere).
try:
    import siteconf
    GROUP_NS = siteconf.GROUP_NS or "clouds"
except Exception:
    GROUP_NS = "clouds"

# Reuse the exact pod-name -> group rule the rest of the platform uses.
try:
    from cpu_stats import _group_name_from_pod
except Exception:
    def _group_name_from_pod(pod):
        parts = pod.split("-")
        if len(parts) >= 4 and parts[0] == "group":
            return "-".join(parts[1:-2])
        return pod

CGROUP_ROOT = "/sys/fs/cgroup/kubepods.slice"
# QoS sub-slices that can hold pod-level slices. Not all exist (e.g. an idle
# host has no `guaranteed` slice); missing ones are simply skipped.
_QOS_SLICES = ("burstable", "besteffort", "guaranteed")

# uid -> (last usage_usec, monotonic timestamp of that reading). Module-level so
# consecutive sample_groups() calls can compute a real CPU rate. Entries not
# refreshed within 600s are pruned each call so pod churn can't grow it forever.
_LAST = {}


def available():
    """True if cgroup v2 pod accounting looks readable on this host."""
    try:
        return os.path.isdir(CGROUP_ROOT)
    except Exception:
        return False


def _qos_dirs():
    """Existing pod-bearing QoS slice dirs under CGROUP_ROOT."""
    dirs = []
    for qos in _QOS_SLICES:
        d = os.path.join(CGROUP_ROOT, f"kubepods-{qos}.slice")
        if os.path.isdir(d):
            dirs.append((qos, d))
    return dirs


def _pod_slice_dirs():
    """Yield (uid_dashed, path) for every pod-level cgroup slice.

    Pod slices are named ``kubepods-<qos>-pod<uid>.slice`` with the UID's dashes
    turned into underscores.  Missing dirs are skipped silently.
    """
    out = []
    try:
        for qos, qd in _qos_dirs():
            prefix = f"kubepods-{qos}-pod"
            try:
                names = os.listdir(qd)
            except OSError:
                continue
            for name in names:
                if not name.startswith(prefix) or not name.endswith(".slice"):
                    continue
                uid = name[len(prefix):-len(".slice")]
                if not uid:
                    continue
                out.append((uid.replace("_", "-"), os.path.join(qd, name)))
    except Exception:
        pass
    return out


def _pod_uid_to_name():
    """Return {pod_uid: pod_name} from the group namespace, or {}."""
    try:
        r = subprocess.run(
            ["kubectl", "-n", GROUP_NS, "get", "pods", "-o", "json"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            return {}
        data = json.loads(r.stdout)
        out = {}
        for item in data.get("items", []):
            meta = item.get("metadata", {}) or {}
            uid = meta.get("uid")
            name = meta.get("name")
            if uid and name:
                out[uid] = name
        return out
    except Exception:
        return {}


def _read_usage_usec(path):
    """Read cumulative CPU microseconds from a pod slice's cpu.stat, or None."""
    try:
        with open(os.path.join(path, "cpu.stat")) as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[0] == "usage_usec":
                    return int(parts[1])
    except Exception:
        return None
    return None


def _read_memory_bytes(path):
    """Read memory.current (bytes) for a pod slice, or None."""
    try:
        with open(os.path.join(path, "memory.current")) as f:
            return int(f.read().strip())
    except Exception:
        return None


def _read_inactive_file_bytes(path):
    """Read reclaimable file cache (``inactive_file``, bytes) from memory.stat.

    Returns 0 when the counter is missing/unreadable, so the caller falls back
    to raw ``memory.current``.
    """
    try:
        with open(os.path.join(path, "memory.stat")) as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[0] == "inactive_file":
                    return int(parts[1])
    except Exception:
        pass
    return 0


def sample_groups():
    """Return {group_name: (cpu_cores, mem_gi)} sampled instantaneously.

    cpu_cores is derived from the delta of the cumulative ``usage_usec`` counter
    since the previous call for the same pod UID.  The first time a pod UID is
    seen there is no delta, so it contributes 0.0 cores for that call (the next
    call, ~60s later, is accurate).  mem_gi is the kubelet working set —
    ``memory.current`` minus reclaimable file cache (``inactive_file``) — so it
    tracks ``kubectl top`` / metrics-server rather than raw page cache.  Pods
    whose cgroup dir is missing are omitted.  Never raises.
    """
    try:
        if not available():
            return {}
        uid_name = _pod_uid_to_name()
        if not uid_name:
            return {}
        now = time.monotonic()
        out = {}
        for uid, path in _pod_slice_dirs():
            name = uid_name.get(uid)
            if not name:
                continue
            usage = _read_usage_usec(path)
            if usage is None:
                continue
            mem_b = _read_memory_bytes(path)
            if mem_b is None:
                continue
            # working set = current - reclaimable file cache, so a cache-heavy
            # pod (e.g. an LLM with a big page cache) is not over-reserved.
            mem_b = max(0, mem_b - _read_inactive_file_bytes(path))

            prev = _LAST.get(uid)
            _LAST[uid] = (usage, now)
            cpu = 0.0
            if prev is not None:
                d_usage = usage - prev[0]
                d_ts = now - prev[1]
                if d_usage > 0 and d_ts > 0:
                    cpu = d_usage / d_ts / 1e6
            if cpu < 0:
                cpu = 0.0

            group = _group_name_from_pod(name)
            p_cpu, p_mem = out.get(group, (0.0, 0.0))
            out[group] = (p_cpu + cpu, p_mem + mem_b / (1024 ** 3))
        # drop UIDs not seen this cycle so the map can't grow without bound
        for uid in [u for u, (_, ts) in _LAST.items() if now - ts > 600]:
            _LAST.pop(uid, None)
        return out
    except Exception:
        return {}


def sample_live(interval=1.0):
    """Return {group_name: (cpu_cores, mem_gi)} measured on demand.

    ``sample_groups()`` derives the CPU rate from the delta since its *previous*
    call, which is only accurate because ``req_loop`` polls every 60 s and keeps
    the module-level snapshot warm; a one-shot caller (e.g. the web usage
    endpoint) would otherwise read 0 cores for every group.  This variant takes
    two readings ``interval`` seconds apart against a *local* snapshot — leaving
    ``_LAST`` untouched so it can't perturb the req_loop rate — so the on-demand
    path still gets a real, current CPU rate.  Memory is instantaneous, read
    once.  Never raises; returns ``{}`` on any failure.
    """
    try:
        if not available():
            return {}
        uid_name = _pod_uid_to_name()
        if not uid_name:
            return {}
        slices = [
            (uid, path) for uid, path in _pod_slice_dirs() if uid in uid_name
        ]
        if not slices:
            return {}
        t0 = time.monotonic()
        before = {}
        for uid, path in slices:
            u = _read_usage_usec(path)
            if u is not None:
                before[uid] = u
        time.sleep(interval)
        dt = time.monotonic() - t0
        out = {}
        for uid, path in slices:
            name = uid_name.get(uid)
            if not name:
                continue
            usage = _read_usage_usec(path)
            mem_b = _read_memory_bytes(path)
            if usage is None or mem_b is None:
                continue
            mem_b = max(0, mem_b - _read_inactive_file_bytes(path))
            cpu = 0.0
            prev = before.get(uid)
            if prev is not None and usage > prev and dt > 0:
                cpu = (usage - prev) / dt / 1e6
            group = _group_name_from_pod(name)
            p_cpu, p_mem = out.get(group, (0.0, 0.0))
            out[group] = (p_cpu + cpu, p_mem + mem_b / (1024 ** 3))
        return out
    except Exception:
        return {}


if __name__ == "__main__":
    print(json.dumps(sample_groups(), indent=2, sort_keys=True))
