#!/usr/bin/env python3
"""Per-group usage metering daemon: python3 usage_meter.py [--once] [--interval N].

Integrates *actual* resource usage into 核时 / 卡时 (core-hours / card-hours):

- **CPU** — core-seconds from the cgroup v2 cumulative ``usage_usec`` counter
  (a monotonic total, so the integral is exact and independent of the tick
  interval).  Alongside it we record *requested* core-seconds (pod-spec
  requests × dt) so the "占着不用" gap is visible.
- **Memory** — working-set GiB × dt (informational).
- **GPU** — from ``gpu_stats.per_pod_breakdown()`` (nvidia-smi): VRAM in use
  (GiB × dt) and the SM-utilisation integral (card × dt).  SM is a point
  sample extrapolated over dt, so it is an approximation by nature.

Writes raw rows + hourly/daily rollups to ``usage_meter.db`` (single writer,
flock-guarded, WAL).  Mirrors ``fleet_sampler.py``.  Never crashes on a bad
tick; SIGTERM/INT stop cleanly.

Metering cannot backfill usage from before it was first started.
"""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cgroup_stats  # noqa: E402
import cpu_stats  # noqa: E402
import gpu_stats  # noqa: E402
import logutil  # noqa: E402
import siteconf  # noqa: E402
from usage_store import UsageStore  # noqa: E402

NS = cgroup_stats.GROUP_NS
LOG = siteconf.path("usage_meter.log")

# uid -> (last usage_usec, wall ts of that reading).  Kept across ticks so the
# CPU integral is a pure counter delta; entries idle >600s are pruned.
_LAST = {}
_LAST_TS = None

# Fallback request fraction when a pod carries no CPU request at all (mirrors
# req_estimate.DEFAULT_REQ_FRACTION — we only use it to avoid a zero column).
_FALLBACK_REQ_FRACTION = 0.5


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _parse_cpu(q):
    """Parse a Kubernetes CPU quantity ('100m', '2', '1.5') → cores, else 0."""
    if not q:
        return 0.0
    q = str(q).strip()
    try:
        if q.endswith("m"):
            return float(q[:-1]) / 1000.0
        if q.endswith("n"):
            return float(q[:-1]) / 1e9
        return float(q)
    except ValueError:
        return 0.0


def _pods():
    """{uid: {"name", "group", "req_cpu"}} for pods in the group namespace."""
    try:
        r = subprocess.run(
            ["kubectl", "-n", NS, "get", "pods", "-o", "json"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            return {}
        data = json.loads(r.stdout)
    except Exception:
        return {}
    out = {}
    for item in data.get("items", []):
        meta = item.get("metadata") or {}
        uid = meta.get("uid")
        name = meta.get("name")
        if not uid or not name:
            continue
        req = 0.0
        for c in (item.get("spec") or {}).get("containers") or []:
            req += _parse_cpu(((c.get("resources") or {}).get("requests") or {}).get("cpu"))
        out[uid] = {
            "name": name,
            "group": cpu_stats._group_name_from_pod(name),
            "req_cpu": req,
        }
    return out


def _group_cpu_limits():
    """Best-effort {group: cpu_limit_cores} to size the request fallback."""
    try:
        import groups
        st = groups.load_state() or {}
        out = {}
        for name, g in (st.get("groups") or {}).items():
            # groups store 'cpu' as a limit quantity string
            out[name] = _parse_cpu(g.get("cpu"))
        return out
    except Exception:
        return {}


def take_tick(now):
    """Sample one tick and return (rows, prev_ts).  Pure, no DB writes."""
    global _LAST_TS
    prev_ts = _LAST_TS
    dt = (now - prev_ts) if prev_ts else None
    if dt is not None and not (0 < dt <= 4 * max(1, INTERVAL)):
        dt = float(INTERVAL)

    pods = _pods()
    limits = _group_cpu_limits() if pods else {}
    acc = {}  # group -> dict of accumulators

    def cell(g):
        return acc.setdefault(g, {"cpu": 0.0, "req": 0.0, "mem": 0.0})

    # ── CPU (actual) + memory ──
    if cgroup_stats.available():
        for uid, path in cgroup_stats._pod_slice_dirs():
            p = pods.get(uid)
            if not p:
                continue
            g = p["group"]
            c = cell(g)
            usage = cgroup_stats._read_usage_usec(path)
            if usage is not None:
                prev = _LAST.get(uid)
                _LAST[uid] = (usage, now)
                if prev is None:
                    d = 0  # first sighting: no delta yet
                else:
                    d = usage - prev[0]
                    if d < 0:
                        log(f"counter_reset uid={uid} group={g} prev={prev[0]} now={usage}")
                        d = 0
                    d = d / 1e6  # µs -> core-seconds
                    if d < 0:
                        d = 0.0
                c["cpu"] += d
                if dt:
                    c["req"] += (p["req_cpu"] or _fallback_req(g, limits)) * dt
            mem_b = cgroup_stats._read_memory_bytes(path)
            if mem_b is not None:
                mem_b = max(0, mem_b - cgroup_stats._read_inactive_file_bytes(path))
                c["mem"] += mem_b / (1024 ** 3)

    # prune stale uid baselines (pod churn must not grow the map)
    for uid in [u for u, (_, ts) in _LAST.items() if now - ts > 600]:
        _LAST.pop(uid, None)

    # ── GPU (actual) ──
    gpu = {}
    try:
        bd = gpu_stats.per_pod_breakdown() or {}
    except Exception:
        bd = {}
    for g, per_gpu in bd.items():
        mem_mib = sum((c.get("mem") or 0) for c in per_gpu.values())
        util = sum((c.get("util") or 0) for c in per_gpu.values())
        gpu[g] = {"mem": mem_mib, "util": util}

    # ── assemble rows ──
    rows = []
    for g in set(acc) | set(gpu):
        c = acc.get(g, {"cpu": 0.0, "req": 0.0, "mem": 0.0})
        gu = gpu.get(g, {"mem": 0.0, "util": 0.0})
        d = dt or 0.0
        rows.append({
            "group_name": g,
            "ts": now,
            "dt": d,
            "cpu_core_seconds": c["cpu"],
            "cpu_req_core_seconds": c["req"],
            "mem_gib": c["mem"],
            "mem_gib_seconds": c["mem"] * d,
            "gpu_mem_mib": gu["mem"],
            "gpu_util_sum": gu["util"],
            "gpu_mem_gib_seconds": gu["mem"] / 1024.0 * d,
            "gpu_compute_card_seconds": gu["util"] / 100.0 * d,
        })
    _LAST_TS = now
    return rows, prev_ts


def _fallback_req(group, limits):
    lim = limits.get(group) or 0.0
    if lim <= 0:
        return 0.1  # req_estimate.FLOOR_CPU
    return min(lim, max(0.1, lim * _FALLBACK_REQ_FRACTION))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="run one tick and exit")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()
    if args.interval < 5:
        parser.error("interval must be at least 5 seconds")
    global INTERVAL
    INTERVAL = args.interval

    os.umask(0o027)
    store = UsageStore()
    store.initialize()
    Path(store.path).parent.mkdir(parents=True, exist_ok=True)
    with open(store.path + ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Another usage meter owns this database\n")

        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())

        log(f"usage_meter start interval={args.interval}s db={store.path}")
        while not stop.is_set():
            started = time.monotonic()
            try:
                now = time.time()
                rows, prev_ts = take_tick(now)
                store.write_tick(rows, now, prev_ts)
                log(f"tick ok groups={len(rows)} in {time.monotonic() - started:.1f}s")
            except Exception as exc:
                log(f"tick failed: {type(exc).__name__}: {exc}")
                if args.once:
                    raise
            if args.once:
                break
            stop.wait(max(1, args.interval - (time.monotonic() - started)))


INTERVAL = 30  # default, overwritten in main()

if __name__ == "__main__":
    main()
