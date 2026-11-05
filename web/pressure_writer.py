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
/proc and nvidia-smi so it can't break the panel or the gpu_loop. The tenant
view reads cgroup_stats (stdlib-only, guarded imports) and the raw state
JSONs (gpu_alloc.json / deploys.json) — never the core modules that own them.
Runs as root only because /mnt/sdb/shared is root-owned; the file it writes is
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

Output contract v3 (what apps read)
-----------------------------------
/shared/pressure/pressure.json:
{
  "schema": 3,           // signal schema version (this doc)
  "cpu": 0.82,           // 0..1 overall busy fraction (instantaneous)
  "gpu": 0.41,           // 0..1 avg across GPUs (util); null if no nvidia-smi
  "gpu_mem": 0.55,       // 0..1 avg gpu memory fraction
  "gpu_max": 0.99,       // 0..1 MAX gpu util across cards (single-card hog isn't
                         //        diluted by the avg); null if no nvidia-smi
  "gpu_cards": [         // per-card detail (empty list if no nvidia-smi)
    {"index":0,"util":0.41,"mem":0.95,"temp":27,"power":15.2}
  ],
  "gpu_temp_max": 51,    // hottest GPU sensor, Celsius; null if unavailable
  "mem": 0.55,           // 0..1 host memory used / total
  "swap": 0.10,          // 0..1 swap used / total; null if no swap
  "psi": {"cpu":0.0,"mem":0.0,"io":0.0},  // 0..1 PSI "some avg10" stall frac
  "disk": {"/":0.63,"/mnt/sdb":0.41},     // 0..1 used frac per siteconf.DISK_MOUNTS
  "bw": 0.93,            // 0..1 (rx+tx bytes/s) / link_capacity
  "bw_rx_bps": 93000000, // raw bytes/s inbound
  "bw_tx_bps": 12000000, // raw bytes/s outbound
  "host_cores": 64,      // host logical CPU count (denominator for self-share)
  "host_mem_gib": 251.7, // host MemTotal in GiB (denominator for self-share)
  "stats": {             // sliding window over PRESSURE_WINDOW_S (default 30s):
    "cpu": {"now":0.39,"avg":0.34,"peak":0.71,"n":15},
    "gpu_max": {...}, "gpu": {...}, "gpu_mem": {...}, "gpu_mem_max": {...},
    "gpu_temp_max": {...}, "mem": {...}, "swap": {...}, "bw": {...},
    "psi_cpu": {...}, "psi_mem": {...}, "psi_io": {...}, "psi_max": {...},
    "disk_max": {...}
  },
  "level": {             // v3: hysteretic STABLE tier, per-dimension, on the
                         // same basis tier-2 (priority_kill) evicts on —
                         // gpu is the per-card MAX (gpu_max), not the average.
    "cpu": "high", "gpu": "high", "gpu_mem": "med", "gpu_temp": "low",
    "mem": "med", "swap": "low", "psi": "low", "disk": "low", "bw": "high"
  },
  "level_raw": {         // v2 semantics kept for compatibility: instantaneous
                         // tier, gpu on the cross-card average.
    "cpu": "high", "gpu": "med", "mem": "med", "bw": "high"
  },
  "tenants": {           // anonymous per-tenant footprint (NO names — the file
                         // is one inode shared by every pod, so it cannot be
                         // personalised per reader). Compute YOUR OWN share
                         // locally: read your cgroup's cpu.stat / memory.current
                         // and divide by host_cores / host_mem_gib.
    "n": 41,             // number of tenant groups seen
    "top": 0.44,         // largest single-group cpu share (0..1)
    "shares": {"cpu": [0.44, 0.12, ...],       // desc, capped at TENANT_TOP
               "mem": [0.31, ...]}             // (GPU: see gpu_cards/gpu_max)
  },
  "ts": 1724500000.0     // epoch seconds (time.time())
}
App logic example: if level["bw"] == "high": serve low-res mode.

Contract notes
--------------
- Top-level instantaneous keys (cpu/gpu/gpu_mem/gpu_max/gpu_cards/.../bw/ts)
  keep their v1/v2 meaning and are NEVER redefined — tier-2 (priority_kill)
  evicts on them and must not shift under it.
- v3 INTENTIONALLY redefines ``level`` (v2 built level.gpu on the cross-card
  average, which diluted a single saturated card to "med" while tier-2 would
  evict on the same card — the two tiers disagreed on one machine). The old
  instantaneous average-based tier is preserved verbatim as ``level_raw``.
- ``level`` is hysteretic: entering "high" needs avg>=HIGH or peak>=HIGH for
  PRESSURE_DWELL_UP consecutive cycles (~4s at defaults); leaving "high" needs
  avg<MED for PRESSURE_DWELL_DOWN cycles (~10s). med<->low follows the raw
  tier (benign flapping). So ``level`` is the stable branch for self-degrade
  logic; ``level_raw``/``stats.peak`` are for dashboards and edge detection.
- gpu_temp levels use PRESSURE_TEMP_HIGH (default 85C) / PRESSURE_TEMP_MED
  (default 75C), and gpu_mem uses a near-OOM band PRESSURE_GPU_MEM_HIGH (0.97)
  / PRESSURE_GPU_MEM_MED (0.90) — NOT the 0..1 thresholds — because co-located
  GPU workloads hold a permanent ~0.94 VRAM baseline that must not read "high"
  (mirrors tier-2's GPU_MEM_HARD gate).
- Additive contract: apart from the documented ``level`` redefinition, keys
  are only ever added, never removed or silently changed.

Tune via env: PRESSURE_POLL_S, PRESSURE_LINK_BPS (default: auto from
/sys/class/net/<uplink>/speed, fallback 1 Gbit/s), PRESSURE_HIGH (0.8),
PRESSURE_MED (0.5), PRESSURE_WINDOW_S (30), PRESSURE_DWELL_UP (2),
PRESSURE_DWELL_DOWN (5), PRESSURE_TEMP_HIGH (85), PRESSURE_TEMP_MED (75),
PRESSURE_GPU_MEM_HIGH (0.97), PRESSURE_GPU_MEM_MED (0.90),
PRESSURE_TENANT_EVERY (5), YATTERRA_PRESSURE_TENANTS (=0 disables tenants).
"""
import collections
import json
import os
import shutil
import subprocess
import time

import siteconf

OUT_DIR = siteconf.PRESSURE_DIR
OUT_FILE = os.path.join(OUT_DIR, "pressure.json")
POLL_S = float(os.environ.get("PRESSURE_POLL_S", "2"))
# Link capacity in bytes/s for bw fraction. Auto-calibrated from the uplink's
# /sys/class/net/<if>/speed when the env override is absent; final fallback is
# 1 Gbit/s = 125_000_000 B/s.
LINK_BPS = float(os.environ.get("PRESSURE_LINK_BPS", "0") or 0)
THRESH_HIGH = float(os.environ.get("PRESSURE_HIGH", "0.8"))
THRESH_MED = float(os.environ.get("PRESSURE_MED", "0.5"))
TEMP_HIGH = float(os.environ.get("PRESSURE_TEMP_HIGH", "85"))
TEMP_MED = float(os.environ.get("PRESSURE_TEMP_MED", "75"))
# gpu_mem has its own (much higher) thresholds: co-located GPU workloads keep a
# high permanent VRAM baseline (~0.7-0.94), so reusing the 0.8/0.5 thresholds
# would pin level.gpu_mem at "high" forever. Mirror tier-2's near-OOM gate.
GPU_MEM_HIGH = float(os.environ.get("PRESSURE_GPU_MEM_HIGH", "0.97"))
GPU_MEM_MED = float(os.environ.get("PRESSURE_GPU_MEM_MED", "0.90"))
# Sliding window (seconds) behind stats.* avg/peak and the level hysteresis.
WINDOW_S = float(os.environ.get("PRESSURE_WINDOW_S", "30"))
# Hysteresis dwell, in collection cycles (POLL_S each): cycles the window must
# stay hot before level enters "high", and stay cool before it leaves.
DWELL_UP = int(os.environ.get("PRESSURE_DWELL_UP", "2"))
DWELL_DOWN = int(os.environ.get("PRESSURE_DWELL_DOWN", "5"))
# Tenant view: sample every N cycles (cgroup sampling shells out to kubectl,
# so it must not run on every 2s cycle). 0/1-disable via env.
TENANT_EVERY = max(1, int(os.environ.get("PRESSURE_TENANT_EVERY", "5")))
TENANTS_ON = (os.environ.get("YATTERRA_PRESSURE_TENANTS", "1") or "1") != "0"
TENANT_TOP = 10  # cap per share list, keeps the file small


def _level(frac):
    if frac is None:
        return None
    if frac >= THRESH_HIGH:
        return "high"
    if frac >= THRESH_MED:
        return "med"
    return "low"


def _level_temp(celsius):
    """level() for a Celsius reading (gpu_temp uses its own thresholds)."""
    if celsius is None:
        return None
    if celsius >= TEMP_HIGH:
        return "high"
    if celsius >= TEMP_MED:
        return "med"
    return "low"


# --- sliding window (stats avg/peak + level hysteresis basis) ------------------

# stat key -> (high, med) thresholds for its *level* classification. Keys with
# None thresholds never produce a level (they only feed stats).
_WINDOW_KEYS = ("cpu", "gpu", "gpu_mem", "gpu_mem_max", "gpu_max",
                "gpu_temp_max", "mem", "swap", "bw",
                "psi_cpu", "psi_mem", "psi_io", "psi_max", "disk_max")

_win = {k: collections.deque(maxlen=max(1, int(WINDOW_S / max(POLL_S, 0.1))))
        for k in _WINDOW_KEYS}


def _push(key, val):
    """Append a sample to the window; None is stored as-is (skipped in stats)."""
    if val is not None:
        try:
            val = float(val)
        except (TypeError, ValueError):
            return
    _win[key].append(val)


def _stat(key, now):
    """{now, avg, peak, n} for a window key. avg/peak skip None samples."""
    vals = [v for v in _win[key] if v is not None]
    if not vals:
        return {"now": now, "avg": None, "peak": None, "n": 0}
    return {"now": now,
            "avg": round(sum(vals) / len(vals), 3),
            "peak": round(max(vals), 3),
            "n": len(vals)}


def _link_bps():
    """Effective link capacity: env override > /sys speed of the uplink > 1G."""
    if LINK_BPS > 0:
        return LINK_BPS
    try:
        for ifname in sorted(_uplink_ifaces() or []):
            with open(f"/sys/class/net/{ifname}/speed") as f:
                mbits = int(f.read().strip())
            if mbits > 0:
                return mbits * 125000  # Mbit/s -> bytes/s
    except Exception:
        pass
    return 125000000  # 1 Gbit/s


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


def host_mem_gib():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                if k.strip() == "MemTotal":
                    return round(int(v.split()[0]) / (1024 * 1024), 1)
    except Exception:
        pass
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


def _num(x):
    """Parse a nvidia-smi cell to float, or None ('N/A' / '[Not Supported]')."""
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def gpu_cards():
    """Return per-card [{index, util, mem, temp, power}], or [] .

    ``util``/``mem`` are 0..1 fractions; ``temp`` is Celsius; ``power`` is Watts.
    Unsupported cells (some consumer cards report 'N/A' for power) become null.
    Never raises: any failure yields ``[]`` so the writer keeps running.
    """
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,utilization.gpu,memory.used,"
                "memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            return []
        cards = []
        for line in out.stdout.splitlines():
            p = [x.strip() for x in line.split(",")]
            if len(p) < 4:
                continue
            mu, mt = _num(p[2]), _num(p[3])
            util = _num(p[1])
            idx = p[0]
            cards.append({
                "index": int(idx) if idx.isdigit() else idx,
                "util": round(util / 100.0, 3) if util is not None else None,
                "mem": round(mu / mt, 3) if (mu is not None and mt) else None,
                "temp": _num(p[4]) if len(p) > 4 else None,
                "power": _num(p[5]) if len(p) > 5 else None,
            })
        return cards
    except Exception:
        return []


def psi_frac():
    """Return {"cpu":f,"mem":f,"io":f} from /proc/pressure/* 'some avg10'.

    Each value is the avg10 stall fraction normalised to 0..1 (the kernel prints
    a 0..100 percentage). Missing kernel PSI support / unreadable files yield
    null per resource. Never raises.
    """
    out = {}
    for key, path in (("cpu", "/proc/pressure/cpu"),
                      ("mem", "/proc/pressure/memory"),
                      ("io", "/proc/pressure/io")):
        val = None
        try:
            with open(path) as f:
                for line in f:
                    if not line.startswith("some"):
                        continue
                    for tok in line.split():
                        if tok.startswith("avg10="):
                            val = round(float(tok.split("=", 1)[1]) / 100.0, 3)
                            break
                    break
        except Exception:
            val = None
        out[key] = val
    return out


def disk_frac():
    """Used fraction (0..1) for each configured mount, or null on failure."""
    out = {}
    try:
        mounts = list(getattr(siteconf, "DISK_MOUNTS", None) or ["/"])
    except Exception:
        mounts = ["/"]
    for m in mounts:
        try:
            u = shutil.disk_usage(m)
            out[m] = round(u.used / u.total, 3) if u.total else None
        except Exception:
            out[m] = None
    return out


def swap_frac():
    """Swap used fraction (0..1), or null when there is no swap."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k.strip()] = int(v.split()[0]) * 1024
        total = info.get("SwapTotal", 0)
        if not total:
            return None
        return round((total - info.get("SwapFree", 0)) / total, 3)
    except Exception:
        return None


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
    link = _link_bps()
    frac = round((rx_bps + tx_bps) / link, 3) if link > 0 else None
    return (frac, int(rx_bps), int(tx_bps))


# --- level v3: hysteretic stable tier ------------------------------------------
# level = Schmitt-stabilised tier on the SAME basis tier-2 evicts on (per-card
# max for gpu). Entering "high" needs the window hot (avg>=HIGH or peak>=HIGH)
# for DWELL_UP cycles; leaving needs avg<MED for DWELL_DOWN cycles. med<->low
# follows the raw tier (benign flapping, no state). level_raw keeps the exact
# v2 instantaneous average-based tier for compatibility.
#
# dim -> window key whose stat feeds that dimension's level/hysteresis.
_LEVEL_DIMS = {
    "cpu": "cpu",
    "gpu": "gpu_max",          # v3: per-card max, aligned with tier-2
    "gpu_mem": "gpu_mem_max",
    "gpu_temp": "gpu_temp_max",
    "mem": "mem",
    "swap": "swap",
    "psi": "psi_max",
    "disk": "disk_max",
    "bw": "bw",
}
_hyst = {d: {"lvl": None, "up": 0, "down": 0} for d in _LEVEL_DIMS}


def _dim_thresholds(dim):
    """(high, med) cut-offs for a dimension. gpu_temp uses Celsius; gpu_mem uses
    its near-OOM band; everything else the 0..1 PRESSURE_HIGH/MED."""
    if dim == "gpu_temp":
        return TEMP_HIGH, TEMP_MED
    if dim == "gpu_mem":
        return GPU_MEM_HIGH, GPU_MEM_MED
    return THRESH_HIGH, THRESH_MED


def _raw_level(dim, val):
    """Instantaneous tier for one dimension on its own thresholds."""
    if val is None:
        return None
    hi, med = _dim_thresholds(dim)
    if val >= hi:
        return "high"
    if val >= med:
        return "med"
    return "low"


def _stable_level(dim, raw):
    """Advance the hysteresis state machine one cycle; return the stable tier."""
    key = _LEVEL_DIMS[dim]
    st = _stat(key, None)
    avg, peak = st["avg"], st["peak"]
    high_v, med_v = _dim_thresholds(dim)
    h = _hyst[dim]
    if h["lvl"] is None:
        h["lvl"] = raw  # first cycle: baseline, no dwell
        return raw
    if h["lvl"] == "high":
        if avg is not None and avg < med_v:
            h["down"] += 1
            if h["down"] >= DWELL_DOWN:
                h["lvl"] = _raw_level(dim, avg) or "low"
                h["down"] = h["up"] = 0
        else:
            h["down"] = 0
    else:
        hot = ((avg is not None and avg >= high_v)
               or (peak is not None and peak >= high_v))
        if hot:
            h["up"] += 1
            if h["up"] >= DWELL_UP:
                h["lvl"] = "high"
                h["up"] = h["down"] = 0
        else:
            h["up"] = 0
            # med<->low follows the raw tier directly (no state to flap into)
            if raw in ("med", "low"):
                h["lvl"] = raw
    return h["lvl"]


# --- tenant view (anonymous shares) --------------------------------------------

def collect_tenants():
    """Anonymous per-tenant footprint: {n, top, shares:{cpu,mem}}.

    The pressure file is ONE inode read by every pod, so it cannot name one
    reader's own entry — names would leak across tenants. Instead we publish
    the anonymous distribution (is the pressure concentrated or spread?), and
    each pod computes its OWN share locally from its cgroup counters divided
    by host_cores/host_mem_gib (see pod_guide §8). Lists are sorted desc and
    capped at TENANT_TOP entries.

    Only cpu/mem are published: cgroup v2 measures those per group directly.
    GPU contention is NOT attributed per tenant here (a co-resident ``serve``
    deploy reserves no vram, so a per-tenant vram split would read as all-zero
    noise) — read per-card ``gpu_cards``/``gpu_max`` to see GPU pressure.
    Never raises.
    """
    out = {"n": 0, "top": None, "shares": {"cpu": [], "mem": []}}
    try:
        import cgroup_stats  # stdlib-only, guarded imports — safe standalone
        live = cgroup_stats.sample_groups()
        host_cores = os.cpu_count() or 1
        host_mib = (host_mem_gib() or 1) * 1024
        cpu_shares, mem_shares = [], []
        for group, (cores, gib) in live.items():
            cpu_shares.append(round(cores / host_cores, 4))
            mem_shares.append(round(gib * 1024 / host_mib, 4))
        cpu_shares.sort(reverse=True)
        mem_shares.sort(reverse=True)
        out["n"] = len(cpu_shares)
        out["top"] = cpu_shares[0] if cpu_shares else None
        out["shares"]["cpu"] = cpu_shares[:TENANT_TOP]
        out["shares"]["mem"] = mem_shares[:TENANT_TOP]
    except Exception:
        pass
    return out


# --- writer -------------------------------------------------------------------

_cycle = [0]          # loop counter for TENANT_EVERY
_tenants_cache = None


def collect():
    """Collect all metrics. cpu/bw sample internally; gpu/mem are instant."""
    cpu = cpu_frac()
    mem = mem_frac()
    g_util, g_mem = gpu_frac()
    cards = gpu_cards()
    # gpu_max = busiest single card's util. Derived from the per-card sample so a
    # lone saturated card isn't diluted by the cross-card average. Falls back to
    # the v1 average when per-card detail is unavailable.
    utils = [c["util"] for c in cards if c.get("util") is not None]
    g_max = round(max(utils), 3) if utils else g_util
    # per-card max vram fraction: level.gpu_mem basis (mirrors gpu_max).
    mems = [c["mem"] for c in cards if c.get("mem") is not None]
    g_mem_max = round(max(mems), 3) if mems else g_mem
    # gpu_temp_max powers the thermal alert (host_alerts); null when no sensor.
    temps = [c["temp"] for c in cards if c.get("temp") is not None]
    g_temp = max(temps) if temps else None
    psi = psi_frac()
    psi_vals = [v for v in psi.values() if v is not None]
    psi_max = max(psi_vals) if psi_vals else None
    disk = disk_frac()
    disk_vals = [v for v in disk.values() if v is not None]
    disk_max = max(disk_vals) if disk_vals else None
    bw, rx_bps, tx_bps = bw_frac()
    swap = swap_frac()

    # sliding window: stats avg/peak + hysteresis basis
    _push("cpu", cpu)
    _push("gpu", g_util)
    _push("gpu_mem", g_mem)
    _push("gpu_mem_max", g_mem_max)
    _push("gpu_max", g_max)
    _push("gpu_temp_max", g_temp)
    _push("mem", mem)
    _push("swap", swap)
    _push("bw", bw)
    _push("psi_cpu", psi.get("cpu"))
    _push("psi_mem", psi.get("mem"))
    _push("psi_io", psi.get("io"))
    _push("psi_max", psi_max)
    _push("disk_max", disk_max)
    stats = {k: _stat(k, {"cpu": cpu, "gpu": g_util, "gpu_mem": g_mem,
                          "gpu_mem_max": g_mem_max, "gpu_max": g_max,
                          "gpu_temp_max": g_temp, "mem": mem, "swap": swap,
                          "bw": bw, "psi_cpu": psi.get("cpu"),
                          "psi_mem": psi.get("mem"), "psi_io": psi.get("io"),
                          "psi_max": psi_max, "disk_max": disk_max}[k])
             for k in _WINDOW_KEYS}

    # level_raw: exact v2 semantics (instantaneous, gpu on the cross-card avg)
    level_raw = {
        "cpu": _level(cpu),
        "gpu": _level(g_util),
        "mem": _level(mem),
        "bw": _level(bw),
    }
    # level: v3 hysteretic stable tier, per-dimension, tier-2-aligned basis
    now_vals = {"cpu": cpu, "gpu_max": g_max, "gpu_mem_max": g_mem_max,
                "gpu_temp_max": g_temp, "mem": mem, "swap": swap,
                "psi_max": psi_max, "disk_max": disk_max, "bw": bw}
    level = {}
    for dim, key in _LEVEL_DIMS.items():
        level[dim] = _stable_level(dim, _raw_level(dim, now_vals[key]))

    # tenant view: sampled every TENANT_EVERY cycles (cgroup sampling shells
    # out to kubectl — too heavy for the 2s cycle), cached in between.
    global _tenants_cache
    if TENANTS_ON:
        _cycle[0] += 1
        if _tenants_cache is None or _cycle[0] % TENANT_EVERY == 0:
            _tenants_cache = collect_tenants()

    payload = {
        "schema": 3,
        "cpu": cpu,
        "gpu": g_util,
        "gpu_mem": g_mem,
        "gpu_max": g_max,
        "gpu_cards": cards,
        "gpu_temp_max": g_temp,
        "mem": mem,
        "swap": swap,
        "psi": psi,
        "disk": disk,
        "bw": bw,
        "bw_rx_bps": rx_bps,
        "bw_tx_bps": tx_bps,
        "host_cores": os.cpu_count(),
        "host_mem_gib": host_mem_gib(),
        "stats": stats,
        "level": level,
        "level_raw": level_raw,
        "ts": round(time.time(), 3),
    }
    if TENANTS_ON and _tenants_cache is not None:
        payload["tenants"] = _tenants_cache
    return payload


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
# 只报"突发"压力, 不报"持续负载":
#   某一维度需先真正回落到 **低位(low)** 并连续平静停留 ALERT_CALM_S 秒,
#   才"重新武装"; 武装之后冲进 high 才发一次通知, 报完立即解除武装,
#   必须再次安静下来才可能复报。
#   一直在高位/中位来回震荡(持续负载, 例如 pod 正常占着 GPU/CPU)、
#   以及贴着阈值抖动的情况, 从不真正安静下来 → 始终不武装 → 一律静默。
# 另加 ALERT_COOLDOWN_S 冷却兜底, 防相邻突发过密。
# (terra→sdpy→app 三层降级由 app 侧按 level 字段执行, 与通知解耦;
#  v3 起 level 带 DWELL_UP 滞回, 边沿最多滞后 DWELL_UP*POLL_S ≈ 4s)。
# 刻意不 import cert_alerts(避免在独立进程里重复拉起检查线程), 本地实现
# 同款 _claim_alert 去重 + send_to_users(admin) 直发; 全部 lazy + 吞异常,
# 通知失败绝不影响压力信号写入。
_prev_levels = {}
_low_since = {}     # metric -> 当前连续"低位"起点(monotonic); None=当前不在低位
_armed = {}         # metric -> 是否已从一段平静低位中重新武装(默认未武装=静默基线)
_last_alert = {}    # metric -> 最近一次告警的 monotonic ts

# "重新武装"所需低位平静时长(秒); 持续负载/抖动攒不满 → 不报
ALERT_CALM_S = float(os.environ.get("PRESSURE_ALERT_CALM_S", "600"))
# 同维度两次告警最小间隔(秒)
ALERT_COOLDOWN_S = float(os.environ.get("PRESSURE_ALERT_COOLDOWN_S", "1800"))


def _notify_level_switch(payload):
    try:
        levels = (payload or {}).get("level") or {}
        now = time.monotonic()
        for metric, lvl in levels.items():
            prev = _prev_levels.get(metric)
            _prev_levels[metric] = lvl
            # 跟踪连续低位时长: 攒够 ALERT_CALM_S 即"重新武装"(首轮必未武装)
            if lvl == "low":
                if _low_since.get(metric) is None:
                    _low_since[metric] = now
                if now - _low_since[metric] >= ALERT_CALM_S:
                    _armed[metric] = True
            else:
                _low_since[metric] = None
            if lvl != "high" or prev == "high" or prev is None:
                continue  # 只报进入 high 的边沿(首轮静默基线)
            if not _armed.get(metric):
                continue  # 持续负载/抖动: 未从真正平静的低位重新武装 → 静默
            if now - _last_alert.get(metric, -1e18) < ALERT_COOLDOWN_S:
                continue  # 冷却期内, 不重复报
            _armed[metric] = False  # 报一次即解除武装, 须再次安静方能复报
            _last_alert[metric] = now
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
        # 通知中心留痕的正文必须与推送正文一致: 留痕原先存 body=""，_event_view
        # 会退化成 "Pod「platform」状态异常"，与推送内容对不上。
        body = (f"主机 {metric} 压力升至 high, 已触发降级信号"
                f"(阈值 {THRESH_HIGH}), 低优先级任务可能被驱逐。")
        pwa_alerts.init_db()
        # 借用内部 _claim_alert: at-most-once 去重 + 通知中心留痕(同 cert_alerts 取舍)
        # recipients=admins: 中心可见性与实际推送目标一致(非 admin 不可见)
        if not pwa_alerts._claim_alert(event_key, "pressure", "platform",
                                       {"title": "主机压力升高", "body": body,
                                        "url": "/infra/host"}, admins):
            return
        send_to_users(admins, {
            "title": "主机压力升高",
            "body": body,
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
