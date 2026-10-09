#!/usr/bin/env python3
"""Auto-estimate k8s resource *requests* from actual usage (EWMA).

The user-set ``g["cpu"]`` / ``g["mem"]`` / ``g["storage"]`` stay as **limits**
(hard cap, burst headroom).  This module estimates **requests** (scheduling
reservation) from real usage so the scheduler doesn't over-reserve idle pods —
the root cause of pods stuck Pending with "Insufficient cpu" or
"Insufficient ephemeral-storage" while the node is mostly idle.

Design:
  - CPU is compressible (throttled, not killed) → aggressive overcommit OK:
    request = clip(ewma × CPU_SAFETY + CPU_MARGIN_CORES, floor, limit).
  - Memory is incompressible (OOMKill) → a *relative* headroom fraction is
    kept: request = clip(ewma × (1 + MEM_PCT), floor, limit).  A flat ×1.4
    multiplier stranded memory on big pods (a 145 Gi pod reserved ~204 Gi); the
    ~5% margin lands it near 152 Gi, while the 0.125 Gi floor still trims the
    many tiny sub-1 Gi pods to 128Mi (instead of the old 512Mi).  A constant
    absolute margin is deliberately NOT used: on this node most pods have 4-16
    Gi limits, so a fixed multi-Gi headroom would dominate the estimate and
    *raise* the sub-1 Gi pods to several Gi — the opposite of the goal.
  - The EWMA is complemented by a bounded per-group ring of the last RING_LEN
    raw samples; the effective value is ``max(ewma, p90(ring))`` so bursts are
    covered without letting outliers (p99) inflate the reservation.
  - Ephemeral-storage requests are template-time only: Kubernetes in-place pod
    resize supports CPU/memory, not ephemeral-storage, so changing the storage
    request is deliberately deferred until the pod is naturally recreated.
  - Auto-reconcile only ever *lowers* requests (frees scheduling space).
    Raising happens implicitly on the next user resize/restart via
    ``request_for()`` reading the current EWMA.

State persists to ``/opt/yatterra/req_estimates.json``.  Never raises.
"""
import json
import os
import threading

# ── tunables ──────────────────────────────────────────────────────────────
ALPHA = 0.15          # EWMA smoothing (~10-sample effective window)
CPU_SAFETY = 1.3      # cpu request = ewma × 1.3 (+ absolute margin below)
CPU_MARGIN_CORES = 0.1  # absolute cpu headroom floor (cores) → tiny pods not razor-thin
MEM_PCT = 0.05        # relative memory headroom fraction (incompressible → headroom)
STORAGE_SAFETY = 1.3  # ephemeral request = observed group-home usage × 1.3
FLOOR_CPU = 0.1       # min cpu request (cores) → 100m
FLOOR_MEM_GI = 0.125  # min mem request (Gi)  → 128Mi
FLOOR_STORAGE_GI = 0.0625  # min ephemeral-storage request (Gi) → 64Mi
DEFAULT_REQ_FRACTION = 0.5  # no history yet → request = limit × 0.5
RING_LEN = 64         # bounded raw-sample window per group (percentile estimate)
RING_MIN = 3          # ring must hold at least this many samples to use p90

import siteconf

STATE_PATH = siteconf.path("req_estimates.json")
_lock = threading.Lock()


# ── quantity parsing/formatting ───────────────────────────────────────────
def parse_cpu(s):
    """'123m' / '1.5' / '2' → float cores.  0 on garbage."""
    try:
        s = str(s).strip()
        if s.endswith("m"):
            return int(s[:-1]) / 1000.0
        return float(s)
    except Exception:
        return 0.0


def parse_mem_gi(s):
    """'2Gi' / '512Mi' / '1024Ki' → float Gi.  0 on garbage."""
    try:
        s = str(s).strip()
        units = {"Ki": 1 / (1024 * 1024), "Mi": 1 / 1024, "Gi": 1.0,
                 "Ti": 1024.0}
        for u, f in units.items():
            if s.endswith(u):
                return float(s[:-2]) * f
        return float(s) / (1024 ** 3)  # bare bytes
    except Exception:
        return 0.0


parse_storage_gi = parse_mem_gi


def _round_cpu(x):
    """Round cores to fmt_cpu's granularity: 1m below 1 core, 0.1 core at/above."""
    try:
        v = max(0.0, float(x))
    except Exception:
        return 0.0
    mc = int(round(v * 1000.0))
    if mc < 1000:
        return mc / 1000.0
    return round(mc / 1000.0, 1)


def _round_mem_gi(x):
    """Round Gi to fmt_mem_gi's granularity: 64Mi below 1 Gi, 0.25 Gi at/above."""
    try:
        v = max(0.0, float(x))
    except Exception:
        return 0.0
    if v < 1.0:
        return round(v * 1024.0 / 64.0) * 64.0 / 1024.0
    return round(v * 4.0) / 4.0


def fmt_cpu(cores):
    """float cores → k8s string.

    Sub-1 values are emitted in millicores (e.g. '100m', '250m'); values at or
    above 1 core round to the nearest 0.1 core and are emitted bare ('1', '1.5').
    The 0.1-core floor therefore survives instead of collapsing to '0'.
    """
    v = _round_cpu(cores)
    if v <= 0:
        return "0"
    if v < 1.0:
        return f"{int(round(v * 1000.0))}m"
    return str(int(v)) if v == int(v) else str(v)


def fmt_mem_gi(gi):
    """float Gi → k8s string.

    Below 1 Gi rounds to the nearest 64Mi and formats as '<n>Mi' (so the 0.125 Gi
    floor survives as '128Mi'); at or above 1 Gi rounds to the nearest 0.25 Gi and
    formats as '<n>Gi' (e.g. '1.25Gi').
    """
    v = _round_mem_gi(gi)
    if v < 1.0:
        return f"{int(round(v * 1024.0))}Mi"
    return f"{int(v)}Gi" if v == int(v) else f"{v}Gi"


def fmt_storage_gi(gi):
    """float Gi → k8s storage quantity. Round to nearest 16Mi."""
    v = max(0.0, round(gi * 64) / 64.0)
    if v >= 1.0:
        return f"{int(v) if v == int(v) else v}Gi"
    return f"{max(1, int(v * 1024))}Mi"


def pctile(sorted_list, p):
    """Linear-interpolated p-th percentile (0..100) of an ascending list.

    Returns 0.0 for an empty list.  Never raises.
    """
    try:
        if not sorted_list:
            return 0.0
        if p <= 0:
            return float(sorted_list[0])
        if p >= 100:
            return float(sorted_list[-1])
        k = (len(sorted_list) - 1) * (p / 100.0)
        lo = int(k)
        hi = min(lo + 1, len(sorted_list) - 1)
        frac = k - lo
        return float(sorted_list[lo]) * (1 - frac) + float(sorted_list[hi]) * frac
    except Exception:
        return 0.0


# ── state persistence ─────────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    try:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, sort_keys=True)
        os.replace(tmp, STATE_PATH)
    except Exception:
        pass


# ── target request from EWMA ──────────────────────────────────────────────
def eff_cpu_mem(e):
    """Effective (cpu, mem) for target sizing: ``max(ewma, p90(ring))``.

    Falls back to the plain EWMA when the raw-sample ring is empty or too small
    (fewer than RING_MIN samples).  Never raises → (0.0, 0.0) on error.
    """
    try:
        ewma_cpu = e.get("cpu_ewma", 0.0) or 0.0
        ewma_mem = e.get("mem_ewma", 0.0) or 0.0
        ring_cpu = e.get("cpu_ring") or []
        ring_mem = e.get("mem_ring") or []
        eff_cpu = (max(ewma_cpu, pctile(sorted(ring_cpu), 90))
                   if len(ring_cpu) >= RING_MIN else ewma_cpu)
        eff_mem = (max(ewma_mem, pctile(sorted(ring_mem), 90))
                   if len(ring_mem) >= RING_MIN else ewma_mem)
        return eff_cpu, eff_mem
    except Exception:
        return 0.0, 0.0


def _target_cpu(ewma, limit):
    """Desired cpu request: clamp(FLOOR, limit, ewma × CPU_SAFETY + CPU_MARGIN_CORES).

    CPU is compressible, so the multiplicative safety factor (overcommit) stays;
    a small absolute margin keeps tiny pods from being razor-thin.  Rounded to
    the granularity fmt_cpu emits.  Never raises.
    """
    try:
        t = _round_cpu(ewma * CPU_SAFETY + CPU_MARGIN_CORES)
        return min(limit, max(FLOOR_CPU, t))
    except Exception:
        return FLOOR_CPU


def _target_mem_gi(ewma_gi, limit_gi):
    """Desired memory request: clamp(FLOOR, limit, ewma × (1 + MEM_PCT)).

    Memory is incompressible (OOMKill), so a headroom fraction is preserved —
    but as a *relative* margin instead of the flat ×1.4 multiplier.  For a
    145 Gi ewma this yields ~152 Gi (the old model stranded ~204 Gi), while the
    0.125 Gi floor still cuts the tiny sub-1 Gi pods to 128Mi.  A constant
    absolute margin is intentionally not added: most pods on this node have
    4-16 Gi limits, so e.g. a fixed 3 Gi headroom would dominate small pods and
    *raise* their requests to several Gi — defeating the whole point of the
    estimator.  Rounded to the granularity fmt_mem_gi emits.  Never raises.
    """
    try:
        t = _round_mem_gi(ewma_gi * (1.0 + MEM_PCT))
        return min(limit_gi, max(FLOOR_MEM_GI, t))
    except Exception:
        return FLOOR_MEM_GI


def _target_storage_gi(ewma_gi, limit_gi):
    t = round(ewma_gi * STORAGE_SAFETY * 4) / 4.0
    return min(limit_gi, max(FLOOR_STORAGE_GI, t))


# ── public API ────────────────────────────────────────────────────────────
def request_for(g):
    """Return (cpu_req_str, mem_req_str, storage_req_str) for deployment_yaml.

    Computes the request from the accumulated EWMA at pod-creation time.
    With no history (brand-new group), falls back to
    ``min(limit, limit × DEFAULT_REQ_FRACTION)`` for CPU/memory.  Storage uses
    a small floor until usage history exists, because group home data lives on a
    hostPath and should not reserve the user's full storage cap in scheduler
    accounting.  This is only called when a pod is being (re)created — it never
    triggers restarts on its own.
    """
    name = g.get("name", "")
    limit_cpu = parse_cpu(g.get("cpu", "1"))
    limit_mem = parse_mem_gi(g.get("mem", "1Gi"))
    limit_storage = parse_storage_gi(g.get("storage", "1Gi"))
    st = load_state()
    e = st.get(name) or {}
    # ``storage`` is backed by a hostPath. HostPath usage is not Kubernetes
    # ephemeral-storage usage, so never turn the directory's byte count into a
    # scheduler reservation. Keep a small writable-layer baseline instead; the
    # EWMA remains available for UI/alerting and future filesystem quota support.
    storage_req = fmt_storage_gi(min(limit_storage, FLOOR_STORAGE_GI))
    if e.get("cpu_ewma") is None or e.get("samples", 0) < 3:
        # not enough history → conservative fallback
        cpu_req = fmt_cpu(min(limit_cpu, max(FLOOR_CPU, limit_cpu * DEFAULT_REQ_FRACTION)))
        mem_req = fmt_mem_gi(min(limit_mem, max(FLOOR_MEM_GI, limit_mem * DEFAULT_REQ_FRACTION)))
        return cpu_req, mem_req, storage_req
    eff_cpu, eff_mem = eff_cpu_mem(e)
    cpu_req = fmt_cpu(_target_cpu(eff_cpu, limit_cpu))
    mem_req = fmt_mem_gi(_target_mem_gi(eff_mem, limit_mem))
    return cpu_req, mem_req, storage_req


def update_ewma(name, sample_cpu, sample_mem_gi, sample_storage_gi=None):
    """Incorporate one sample into the EWMA and persist.  Returns the entry.

    Cold-start: the first sample seeds the EWMA directly (instead of 0) so the
    estimate is immediately meaningful and doesn't collapse to the floor.  The
    raw sample is also appended to a bounded per-group ring (cpu_ring/mem_ring,
    capped at RING_LEN) used by ``eff_cpu_mem`` for a p90 burst estimate.
    """
    with _lock:
        st = load_state()
        e = st.get(name) or {}
        n = e.get("samples", 0)
        if n == 0:
            e["cpu_ewma"] = round(sample_cpu, 3)
            e["mem_ewma"] = round(sample_mem_gi, 3)
        else:
            old_cpu = e.get("cpu_ewma", 0.0)
            old_mem = e.get("mem_ewma", 0.0)
            e["cpu_ewma"] = round(ALPHA * sample_cpu + (1 - ALPHA) * old_cpu, 3)
            e["mem_ewma"] = round(ALPHA * sample_mem_gi + (1 - ALPHA) * old_mem, 3)
        e["samples"] = n + 1
        # bounded raw-sample window (percentile estimate); capped at RING_LEN
        rc = list(e.get("cpu_ring") or [])
        rm = list(e.get("mem_ring") or [])
        rc.append(round(sample_cpu, 4))
        rm.append(round(sample_mem_gi, 4))
        e["cpu_ring"] = rc[-RING_LEN:]
        e["mem_ring"] = rm[-RING_LEN:]
        if sample_storage_gi is not None:
            sn = e.get("storage_samples", 0)
            if sn == 0:
                e["storage_ewma"] = round(sample_storage_gi, 3)
            else:
                old_storage = e.get("storage_ewma", 0.0)
                e["storage_ewma"] = round(ALPHA * sample_storage_gi + (1 - ALPHA) * old_storage, 3)
            e["storage_samples"] = sn + 1
        st[name] = e
        save_state(st)
        return e


def reconcile_target(name, limit_cpu, limit_mem_gi, limit_storage_gi=None):
    """Compute request targets from current EWMA without mutating state."""
    st = load_state()
    e = st.get(name) or {}
    eff_cpu, eff_mem = eff_cpu_mem(e)
    t_cpu = _target_cpu(eff_cpu, limit_cpu)
    t_mem = _target_mem_gi(eff_mem, limit_mem_gi)
    if limit_storage_gi is None:
        return fmt_cpu(t_cpu), fmt_mem_gi(t_mem), t_cpu, t_mem
    ewma_storage = e.get("storage_ewma", 0.0)
    t_storage = _target_storage_gi(ewma_storage, limit_storage_gi)
    return fmt_cpu(t_cpu), fmt_mem_gi(t_mem), fmt_storage_gi(t_storage), t_cpu, t_mem, t_storage


def current_request(name):
    """Return (cpu_req_str, mem_req_str) currently persisted, or (None, None)."""
    e = (load_state().get(name) or {})
    return e.get("cpu_req"), e.get("mem_req")


def mark_applied(name, cpu_req, mem_req, ts):
    """Record that we applied this request at time ts."""
    with _lock:
        st = load_state()
        e = st.get(name) or {}
        e["cpu_req"] = cpu_req
        e["mem_req"] = mem_req
        e["last_apply"] = ts
        st[name] = e
        save_state(st)


def mark_resized(name, cpu_req, mem_req, ts):
    """Record an in-place resize at time ts."""
    with _lock:
        st = load_state()
        e = st.get(name) or {}
        e["cpu_req"] = cpu_req
        e["mem_req"] = mem_req
        e["last_resize"] = ts
        st[name] = e
        save_state(st)
