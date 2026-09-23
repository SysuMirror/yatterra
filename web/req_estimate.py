#!/usr/bin/env python3
"""Auto-estimate k8s resource *requests* from actual usage (EWMA).

The user-set ``g["cpu"]`` / ``g["mem"]`` / ``g["storage"]`` stay as **limits**
(hard cap, burst headroom).  This module estimates **requests** (scheduling
reservation) from real usage so the scheduler doesn't over-reserve idle pods —
the root cause of pods stuck Pending with "Insufficient cpu" or
"Insufficient ephemeral-storage" while the node is mostly idle.

Design:
  - CPU is compressible (throttled, not killed) → aggressive overcommit OK.
  - Memory is incompressible (OOMKill) → more conservative safety factor.
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
CPU_SAFETY = 1.3      # cpu request = ewma × 1.3
MEM_SAFETY = 1.4      # mem request = ewma × 1.4 (incompressible, more headroom)
STORAGE_SAFETY = 1.3  # ephemeral request = observed group-home usage × 1.3
FLOOR_CPU = 0.5       # min cpu request (cores)
FLOOR_MEM_GI = 0.5    # min mem request (Gi)  → 512Mi
FLOOR_STORAGE_GI = 0.0625  # min ephemeral-storage request (Gi) → 64Mi
DEFAULT_REQ_FRACTION = 0.5  # no history yet → request = limit × 0.5

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


def fmt_cpu(cores):
    """float cores → k8s string.  Round to nearest 0.5."""
    v = max(0.0, cores)
    v = round(v * 2) / 2.0
    if v == int(v):
        return str(int(v))
    return str(v)


def fmt_mem_gi(gi):
    """float Gi → k8s string like '4Gi'.  Round to nearest 0.5 Gi."""
    v = max(0.0, gi)
    v = round(v * 2) / 2.0
    if v >= 1.0:
        return f"{int(v) if v == int(v) else v}Gi"
    return f"{int(v * 1024)}Mi"


def fmt_storage_gi(gi):
    """float Gi → k8s storage quantity. Round to nearest 16Mi."""
    v = max(0.0, round(gi * 64) / 64.0)
    if v >= 1.0:
        return f"{int(v) if v == int(v) else v}Gi"
    return f"{max(1, int(v * 1024))}Mi"


def _round_half(x):
    return round(x * 2) / 2.0


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
def _target_cpu(ewma, limit):
    """Desired cpu request: clamp(floor, limit, ewma × safety)."""
    t = _round_half(ewma * CPU_SAFETY)
    return min(limit, max(FLOOR_CPU, t))


def _target_mem_gi(ewma_gi, limit_gi):
    t = _round_half(ewma_gi * MEM_SAFETY)
    return min(limit_gi, max(FLOOR_MEM_GI, t))


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
    ewma_cpu = e.get("cpu_ewma")
    ewma_mem = e.get("mem_ewma")
    # ``storage`` is backed by a hostPath. HostPath usage is not Kubernetes
    # ephemeral-storage usage, so never turn the directory's byte count into a
    # scheduler reservation. Keep a small writable-layer baseline instead; the
    # EWMA remains available for UI/alerting and future filesystem quota support.
    storage_req = fmt_storage_gi(min(limit_storage, FLOOR_STORAGE_GI))
    if ewma_cpu is None or e.get("samples", 0) < 3:
        # not enough history → conservative fallback
        cpu_req = fmt_cpu(min(limit_cpu, max(FLOOR_CPU, limit_cpu * DEFAULT_REQ_FRACTION)))
        mem_req = fmt_mem_gi(min(limit_mem, max(FLOOR_MEM_GI, limit_mem * DEFAULT_REQ_FRACTION)))
        return cpu_req, mem_req, storage_req
    cpu_req = fmt_cpu(_target_cpu(ewma_cpu, limit_cpu))
    mem_req = fmt_mem_gi(_target_mem_gi(ewma_mem, limit_mem))
    return cpu_req, mem_req, storage_req


def update_ewma(name, sample_cpu, sample_mem_gi, sample_storage_gi=None):
    """Incorporate one sample into the EWMA and persist.  Returns the entry.

    Cold-start: the first sample seeds the EWMA directly (instead of 0) so the
    estimate is immediately meaningful and doesn't collapse to the floor.
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
    ewma_cpu = e.get("cpu_ewma", 0.0)
    ewma_mem = e.get("mem_ewma", 0.0)
    t_cpu = _target_cpu(ewma_cpu, limit_cpu)
    t_mem = _target_mem_gi(ewma_mem, limit_mem_gi)
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
