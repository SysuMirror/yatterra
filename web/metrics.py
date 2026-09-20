#!/usr/bin/env python3
"""Background metrics sampling for the admin console observability panel.

A single daemon thread is started once on import (guarded by a module-level
flag) and takes a sample every ``INTERVAL`` seconds, keeping the most recent
``MAX_SAMPLES`` samples in a ring buffer protected by ``threading.Lock``.

Each sample records:
  * host CPU utilization   (two reads of /proc/stat, diff over a short window)
  * host memory utilization (read /proc/meminfo)
  * per-GPU util + mem_used (nvidia-smi --query-gpu=...)
  * per-group cpu/mem       (kubectl top pod in the group namespace,
                             pod name ``group-foo-bar-xxx`` -> ``foo-bar``)

External commands (kubectl / nvidia-smi) failing only blanks the affected
fields for that sample; the thread never raises and never stops.

Public API:
  * ``metrics_snapshot()`` -> downsampled time-series dict (<= 120 points)
  * ``metrics_now()``      -> latest instantaneous sample

This module never raises from its public functions: on any error it returns a
dict carrying an ``error`` key with sensible defaults.
"""
import math
import os
import subprocess
import threading
import time

import kvcache

import siteconf

NS = siteconf.GROUP_NS
INTERVAL = 10          # seconds between samples
MAX_SAMPLES = 360      # 1 hour at 10s
DOWNSAMPLE_TO = 120    # max points returned by metrics_snapshot()
_CPU_SAMPLE_WINDOW = 0.5  # seconds between the two /proc/stat reads

# Counter snapshots used to turn /proc counters into per-second rates.  The
# sampler is single-threaded, so these do not need a second lock.
_counter_snapshot = None

# Ring buffer + lock
_lock = threading.Lock()
_samples = []          # list of sample dicts, newest appended at the end

# Single-thread guard
_started = False
_thread = None


# --------------------------------------------------------------------------- #
# Low-level collectors — each returns None / {} on failure, never raises.      #
# --------------------------------------------------------------------------- #
def _cpu_jiffies():
    """Return (total, idle) jiffies from the first line of /proc/stat, or None."""
    try:
        with open("/proc/stat") as f:
            first = f.readline()
        parts = first.split()
        if not parts or parts[0] != "cpu":
            return None
        vals = [int(x) for x in parts[1:]]
        if not vals:
            return None
        total = sum(vals)
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        return (total, idle)
    except Exception:
        return None


def _host_cpu_pct():
    """Overall CPU busy % sampled over ~_CPU_SAMPLE_WINDOW s. None on failure."""
    a = _cpu_jiffies()
    if a is None:
        return None
    time.sleep(_CPU_SAMPLE_WINDOW)
    b = _cpu_jiffies()
    if b is None:
        return None
    d_total = b[0] - a[0]
    d_idle = b[1] - a[1]
    if d_total <= 0:
        return None
    return round(((d_total - d_idle) / d_total) * 100.0, 1)


def _host_mem_pct():
    """Memory utilization % from /proc/meminfo. None on failure."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                p = line.split()
                if len(p) >= 2 and p[0].endswith(":"):
                    info[p[0][:-1]] = int(p[1])
        total = info.get("MemTotal")
        if not total:
            return None
        if "MemAvailable" in info:
            used = total - info["MemAvailable"]
        else:
            free = info.get("MemFree", 0)
            buffers = info.get("Buffers", 0)
            cached = info.get("Cached", 0)
            used = total - free - buffers - cached
        if used < 0:
            used = 0
        return round((used / total) * 100.0, 1)
    except Exception:
        return None


def _host_mem_stats():
    """Return memory/swap capacity counters in bytes where available."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                p = line.split()
                if len(p) >= 2 and p[0].endswith(":"):
                    info[p[0][:-1]] = int(p[1]) * 1024
        total = info.get("MemTotal")
        available = info.get("MemAvailable")
        swap_total = info.get("SwapTotal", 0)
        swap_free = info.get("SwapFree", 0)
        return {
            "available_bytes": available,
            "swap_used_bytes": max(0, swap_total - swap_free),
            "swap_total_bytes": swap_total,
            "swap_in_bytes_sec": None,
            "swap_out_bytes_sec": None,
        } if total else {}
    except Exception:
        return {}


def _read_net_counters():
    """Read aggregate network counters, excluding loopback."""
    totals = {"rx_bytes": 0, "tx_bytes": 0, "rx_packets": 0, "tx_packets": 0,
              "rx_dropped": 0, "tx_dropped": 0, "rx_errors": 0, "tx_errors": 0}
    interfaces = {}
    try:
        with open("/proc/net/dev") as f:
            for line in f:
                if ":" not in line:
                    continue
                name, raw = line.split(":", 1)
                name = name.strip()
                if name == "lo":
                    continue
                # Container bridges/veths mirror host traffic and would
                # otherwise double-count the real NIC throughput.
                if name.startswith(("veth", "cni", "docker", "flannel", "br-", "virbr")):
                    continue
                vals = raw.split()
                if len(vals) < 16:
                    continue
                keys = ("rx_bytes", "rx_packets", "rx_errors", "rx_dropped",
                        "tx_bytes", "tx_packets", "tx_errors", "tx_dropped")
                row = {k: int(vals[i]) for k, i in zip(keys, (0, 1, 2, 3, 8, 9, 10, 11))}
                interfaces[name] = row
                for k, v in row.items():
                    totals[k] += v
    except Exception:
        return {}, {}
    return totals, interfaces


def _read_disk_counters():
    """Read block-device counters from /proc/diskstats (bytes and IO time)."""
    totals = {"read_bytes": 0, "write_bytes": 0, "read_ops": 0, "write_ops": 0,
              "io_ms": 0, "weighted_io_ms": 0}
    try:
        with open("/proc/diskstats") as f:
            for line in f:
                p = line.split()
                if len(p) < 14:
                    continue
                dev = p[2]
                # Only whole block devices; partitions would double count.
                if os.path.exists(f"/sys/class/block/{dev}/partition"):
                    continue
                vals = [int(x) for x in p[3:14]]
                totals["read_ops"] += vals[0]
                totals["read_bytes"] += vals[2] * 512
                totals["write_ops"] += vals[4]
                totals["write_bytes"] += vals[6] * 512
                totals["io_ms"] += vals[9]
                totals["weighted_io_ms"] += int(p[13])
    except Exception:
        return {}
    return totals


def _rate_metrics():
    """Return network and disk rates derived from monotonic counters."""
    global _counter_snapshot
    now = time.monotonic()
    net, interfaces = _read_net_counters()
    disk = _read_disk_counters()
    if not net or not disk:
        return {"network": {"interfaces": {}}, "disk": {}}
    previous = _counter_snapshot
    _counter_snapshot = {"ts": now, "net": net, "disk": disk}
    network = {"interfaces": interfaces}
    result_disk = {}
    if previous:
        elapsed = now - previous["ts"]
        if elapsed > 0:
            def delta(kind, obj, key):
                d = obj.get(key, 0) - previous.get(kind, {}).get(key, 0)
                return max(0, d)
            for key in ("rx_bytes", "tx_bytes", "rx_packets", "tx_packets", "rx_dropped", "tx_dropped", "rx_errors", "tx_errors"):
                network[key + "_per_sec"] = round(delta("net", net, key) / elapsed, 3)
            network["rx_drop_pct"] = round(100 * delta("net", net, "rx_dropped") / max(1, delta("net", net, "rx_packets") + delta("net", net, "rx_dropped")), 4)
            network["tx_drop_pct"] = round(100 * delta("net", net, "tx_dropped") / max(1, delta("net", net, "tx_packets") + delta("net", net, "tx_dropped")), 4)
            for key in ("read_bytes", "write_bytes", "read_ops", "write_ops"):
                result_disk[key + "_per_sec"] = round(delta("disk", disk, key) / elapsed, 3)
            io_ops = delta("disk", disk, "read_ops") + delta("disk", disk, "write_ops")
            result_disk["await_ms"] = round(delta("disk", disk, "weighted_io_ms") / max(1, io_ops), 3)
            result_disk["busy_pct"] = round(min(100, 100 * delta("disk", disk, "io_ms") / (elapsed * 1000)), 2)
            result_disk["queue_depth"] = round(delta("disk", disk, "weighted_io_ms") / max(1, elapsed * 1000), 3)
    return {"network": network, "disk": result_disk}


def _query_gpus():
    """Return {index_str: {"util": int, "mem": int}} or {} on failure."""
    out = {}
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,utilization.gpu,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            return {}
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 3:
                continue
            try:
                idx = int(parts[0])
                util = int(parts[1])
                mem = int(parts[2])
            except ValueError:
                continue
            out[str(idx)] = {"util": util, "mem": mem}
    except Exception:
        return {}
    return out


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


def _parse_cpu_millicores(token):
    """Parse a kubectl top cpu token ('100m' / '2') to millicores int.

    Returns None on failure.
    """
    try:
        token = token.strip()
        if token.endswith("m"):
            return int(token[:-1])
        return int(float(token) * 1000)
    except Exception:
        return None


def _parse_mem_mib(token):
    """Parse a kubectl top memory token ('123Mi' / '1Gi') to MiB int.

    Returns None on failure.
    """
    try:
        token = token.strip()
        units = {"Ki": 1 / 1024.0, "Mi": 1.0, "Gi": 1024.0, "Ti": 1024.0 * 1024.0}
        for suf, mult in units.items():
            if token.endswith(suf):
                return int(float(token[:-2]) * mult)
        # No suffix: assume KiB (kubectl default for raw bytes is uncommon here)
        return int(float(token) / 1024.0)
    except Exception:
        return None


def _query_groups():
    """Return {name: {"cpu": int_millicores, "mem": int_MiB}} or {} on failure.

    cpu/mem values that fail to parse are stored as None so the series can
    still record presence of the group.
    """
    out = {}
    try:
        r = subprocess.run(
            ["kubectl", "-n", NS, "top", "pod", "--no-headers"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if r.returncode != 0:
            return {}
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            cols = line.split()
            if len(cols) < 3:
                continue
            pod, cpu_tok, mem_tok = cols[0], cols[1], cols[2]
            name = _group_name_from_pod(pod)
            cpu = _parse_cpu_millicores(cpu_tok)
            mem = _parse_mem_mib(mem_tok)
            out[name] = {"cpu": cpu, "mem": mem}
    except Exception:
        return {}
    return out


# --------------------------------------------------------------------------- #
# Sampling                                                                     #
# --------------------------------------------------------------------------- #
def _take_sample():
    """Build one sample dict. Never raises; failed fields are blanked."""
    sample = {
        "ts": time.time(),
        "host_cpu": None,
        "host_mem": None,
        "mem": {},
        "network": {"interfaces": {}},
        "disk": {},
        "gpus": {},
        "groups": {},
    }
    try:
        sample["host_cpu"] = _host_cpu_pct()
    except Exception:
        sample["host_cpu"] = None
    try:
        sample["host_mem"] = _host_mem_pct()
    except Exception:
        sample["host_mem"] = None
    try:
        sample["mem"] = _host_mem_stats()
    except Exception:
        sample["mem"] = {}
    try:
        rates = _rate_metrics()
        sample["network"] = rates.get("network", {})
        sample["disk"] = rates.get("disk", {})
    except Exception:
        sample["network"], sample["disk"] = {"interfaces": {}}, {}
    try:
        sample["gpus"] = _query_gpus()
    except Exception:
        sample["gpus"] = {}
    try:
        sample["groups"] = _query_groups()
    except Exception:
        sample["groups"] = {}
    return sample


def _sampler_loop():
    """Main loop of the background thread. Runs forever, swallows all errors."""
    while True:
        try:
            sample = _take_sample()
            with _lock:
                _samples.append(sample)
                if len(_samples) > MAX_SAMPLES:
                    del _samples[: len(_samples) - MAX_SAMPLES]
            # Push to Redis so other processes / restarts get warm cache
            try:
                now_data = {
                    "ts": sample.get("ts", 0.0),
                    "host_cpu": sample.get("host_cpu"),
                    "host_mem": sample.get("host_mem"),
                    "mem": sample.get("mem", {}),
                    "network": sample.get("network", {}),
                    "disk": sample.get("disk", {}),
                    "gpus": sample.get("gpus", {}),
                    "groups": sample.get("groups", {}),
                }
                kvcache.set("metrics:now", now_data, ttl=15)
                # Also push snapshot to Redis every cycle
                snap = _build_snapshot()
                kvcache.set("metrics:snapshot", snap, ttl=15)
            except Exception:
                pass
        except Exception:
            # Never let the thread die from an unexpected error.
            pass
        try:
            time.sleep(INTERVAL)
        except Exception:
            break


def _start_thread():
    """Start the background sampler thread once (idempotent, guarded by flag)."""
    global _started, _thread
    if _started:
        return
    try:
        t = threading.Thread(target=_sampler_loop, name="metrics-sampler", daemon=True)
        t.start()
        _thread = t
        _started = True
    except Exception:
        _started = False


# --------------------------------------------------------------------------- #
# Downsample helper                                                            #
# --------------------------------------------------------------------------- #
def _downsample(values, to=DOWNSAMPLE_TO):
    """Return at most ``to`` items from ``values`` preserving coverage.

    Stride-samples when len > to so the full history window is represented
    rather than just the tail. Always returns a new list.
    """
    if not values:
        return []
    n = len(values)
    if n <= to:
        return list(values)
    stride = int(math.ceil(n / float(to)))
    return values[::stride][:to]


# --------------------------------------------------------------------------- #
# Public API                                                                   #
# --------------------------------------------------------------------------- #
def _build_snapshot():
    """Build the snapshot from in-process ring buffer. Returns dict."""
    with _lock:
        snap = list(_samples)
    if not snap:
        return {
            "samples": 0,
            "host_cpu": [],
            "host_mem": [],
            "network": {},
            "disk": {},
            "gpus": {},
            "groups": {},
        }
    # Downsample the sample list first, then derive series from it so all
    # series share the same time alignment.
    ds = _downsample(snap)

    host_cpu = [s["host_cpu"] for s in ds if s.get("host_cpu") is not None]
    host_mem = [s["host_mem"] for s in ds if s.get("host_mem") is not None]

    def series(key):
        return [obj.get(key) for obj in (s.get(obj_name, {}) for s in ds) if obj.get(key) is not None]

    # Keep network/disk series aligned with the sampled window.  Missing first
    # samples are omitted, just like the existing CPU and memory series.
    obj_name = "network"
    network = {k: series(k) for k in (
        "rx_bytes_per_sec", "tx_bytes_per_sec", "rx_packets_per_sec", "tx_packets_per_sec",
        "rx_dropped_per_sec", "tx_dropped_per_sec", "rx_errors_per_sec", "tx_errors_per_sec",
        "rx_drop_pct", "tx_drop_pct")}
    obj_name = "disk"
    disk = {k: series(k) for k in (
        "read_bytes_per_sec", "write_bytes_per_sec", "read_ops_per_sec", "write_ops_per_sec",
        "await_ms", "busy_pct", "queue_depth")}

    # GPU series: union of indices across the downsampled samples.
    gpu_idx = set()
    for s in ds:
        try:
            gpu_idx.update(s.get("gpus", {}).keys())
        except Exception:
            pass
    gpus = {}
    for idx in sorted(gpu_idx, key=lambda x: (int(x) if x.isdigit() else 1 << 30, x)):
        utils = []
        mems = []
        for s in ds:
            g = s.get("gpus", {}).get(idx)
            if not g:
                continue
            if g.get("util") is not None:
                utils.append(g["util"])
            if g.get("mem") is not None:
                mems.append(g["mem"])
        gpus[idx] = {"util": utils, "mem": mems}

    # Group series: union of group names across the downsampled samples.
    group_names = set()
    for s in ds:
        try:
            group_names.update(s.get("groups", {}).keys())
        except Exception:
            pass
    # Prune stale groups against the authoritative group set from state.
    try:
        import groups as _groups
        known = set(_groups.load_state().get("groups", {}).keys())
    except Exception:
        known = set()
    if known:
        group_names &= known
    else:
        group_names = set()
    groups = {}
    for name in sorted(group_names):
        cpus = []
        mems = []
        for s in ds:
            gr = s.get("groups", {}).get(name)
            if not gr:
                continue
            if gr.get("cpu") is not None:
                cpus.append(gr["cpu"])
            if gr.get("mem") is not None:
                mems.append(gr["mem"])
        groups[name] = {"cpu": cpus, "mem": mems}

    return {
        "samples": len(snap),
        "host_cpu": host_cpu,
        "host_mem": host_mem,
        "network": network,
        "disk": disk,
        "gpus": gpus,
        "groups": groups,
    }


def metrics_snapshot():
    """Return a downsampled time-series dict for sparkline rendering.
    Cached in Redis for 10s (written by background thread).

    Shape::

        {"samples": int,
         "host_cpu": [float, ...],          # <= 120 points, 0-100
         "host_mem": [float, ...],          # <= 120 points, 0-100
         "gpus": {"0": {"util": [..], "mem": [..]}, ...},
         "groups": {"name": {"cpu": [..], "mem": [..]}, ...}}

    None entries in the raw samples are dropped from the per-series lists so
    sparklines only plot valid data. Never raises.
    """
    empty = {
        "samples": 0,
        "host_cpu": [],
        "host_mem": [],
        "network": {},
        "disk": {},
        "gpus": {},
        "groups": {},
    }
    # Try Redis first
    cached = kvcache.get("metrics:snapshot")
    if cached is not None:
        return cached
    # Fall back to in-process ring buffer
    try:
        result = _build_snapshot()
        kvcache.set("metrics:snapshot", result, ttl=10)
        return result
    except Exception as e:
        empty["error"] = str(e)
        return empty


def metrics_now():
    """Return the latest instantaneous sample, or a default dict if none yet.
    Cached in Redis for 10s (written by background thread).

    Shape::

        {"ts": float,
         "host_cpu": float|None,
         "host_mem": float|None,
         "gpus": {"0": {"util": int, "mem": int}, ...},
         "groups": {"name": {"cpu": int|None, "mem": int|None}, ...}}

    Never raises.
    """
    default = {
        "ts": 0.0,
        "host_cpu": None,
        "host_mem": None,
        "mem": {},
        "network": {"interfaces": {}},
        "disk": {},
        "gpus": {},
        "groups": {},
    }
    # Try Redis first
    cached = kvcache.get("metrics:now")
    if cached is not None:
        return cached
    # Fall back to in-process ring buffer
    try:
        with _lock:
            if not _samples:
                return default
            s = _samples[-1]
        result = {
            "ts": s.get("ts", 0.0),
            "host_cpu": s.get("host_cpu"),
            "host_mem": s.get("host_mem"),
            "mem": dict(s.get("mem", {})),
            "network": dict(s.get("network", {})),
            "disk": dict(s.get("disk", {})),
            "gpus": dict(s.get("gpus", {})),
            "groups": dict(s.get("groups", {})),
        }
        kvcache.set("metrics:now", result, ttl=10)
        return result
    except Exception as e:
        default["error"] = str(e)
        return default


# --------------------------------------------------------------------------- #
# Start the background sampler on import (once, idempotent).                    #
# --------------------------------------------------------------------------- #
_start_thread()
