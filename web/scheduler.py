#!/usr/bin/env python3
"""GPU scheduler for group deploys.

Two classes:
  - serve (推理): statically pinned to a GPU chosen at deploy creation. Never
    moved. It is the anchor; training yields to it, not the reverse.
  - train (训练): pooled. Placed on the GPU with the most spare capacity
    (VRAM hard constraint, SM util soft preference, penalty for GPUs that
    already host a serve deploy). Migrated/evicted when a serve GPU comes
    under hardware pressure (SM util sustained high).

Pressure signal is hardware sampling (nvidia-smi), per design.

State: <platform root>/gpu_alloc.json (root 600). Single platform process
serializes placements via _LOCK.
"""
import json
import os
import subprocess
import threading

import siteconf

ALLOC_FILE = siteconf.path("gpu_alloc.json")

# --- tunables ---
DEFAULT_TRAIN_VRAM_MB = 12000      # default training VRAM need if deploy omits
PRESSURE_SM_THRESHOLD = 85         # serve GPU SM util % considered "under pressure"
PRESSURE_SUSTAINED_S = 10          # must hold threshold this long before acting
INFERENCE_GPU_PENALTY = 25         # added to sort key for GPUs hosting a serve
SAMPLE_TIMEOUT = 6

# MPS dynamic compute caps for training co-resident on a serve GPU.
# Bands evaluated top-down: first threshold the inference SM is below => that %.
#   inference idle (SM<45)  -> train 85%  (fill spare compute, "打满算力")
#   inference medium (<75) -> train 50%  (share)
#   inference busy (>=75)  -> train 25%  (protect inference latency)
#   inference pressured (>=85 sustained) -> migrate/evict (gpu_loop handle_pressure)
MPS_BANDS = [(45, 85), (75, 50), (101, 25)]

_LOCK = threading.Lock()
_pressure_since = {}               # gpu -> epoch seconds when pressure first seen


# --- hardware sampling ---
def sample():
    """Return list of {index, vram_used, vram_free, sm} via nvidia-smi.
    Empty list on any failure (never raises)."""
    try:
        r = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=index,memory.used,memory.free,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=SAMPLE_TIMEOUT,
        )
    except Exception:
        return []
    if r.returncode != 0:
        return []
    out = []
    for line in (r.stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            out.append({
                "index": int(parts[0]),
                "vram_used": int(parts[1]),
                "vram_free": int(parts[2]),
                "sm": int(parts[3]),
            })
        except ValueError:
            continue
    return out


def num_gpus():
    return len(sample())


# --- alloc state ---
def load_alloc():
    if not os.path.exists(ALLOC_FILE):
        return {"deploys": {}}
    try:
        with open(ALLOC_FILE) as f:
            d = json.load(f)
        if "deploys" not in d:
            d = {"deploys": {}}
        return d
    except Exception:
        return {"deploys": {}}


def save_alloc(alloc):
    tmp = ALLOC_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(alloc, f, indent=2, sort_keys=True)
    os.replace(tmp, ALLOC_FILE)
    try:
        os.chmod(ALLOC_FILE, 0o600)
    except OSError:
        pass


def _record(deploy_id, rec):
    with _LOCK:
        alloc = load_alloc()
        alloc.setdefault("deploys", {})[deploy_id] = rec
        save_alloc(alloc)


def release(deploy_id):
    """Drop a deploy from the alloc table (stop/delete). Best-effort."""
    with _LOCK:
        alloc = load_alloc()
        alloc.setdefault("deploys", {}).pop(deploy_id, None)
        save_alloc(alloc)


def mark(deploy_id, status, gpu=None):
    """Update an alloc record's status (and optionally gpu) without re-placing."""
    with _LOCK:
        alloc = load_alloc()
        rec = alloc.setdefault("deploys", {}).get(deploy_id)
        if not rec:
            return
        rec["status"] = status
        if gpu is not None:
            rec["gpu"] = gpu
        save_alloc(alloc)


def queued_trains():
    """Train deploys parked waiting for a GPU (status=queued)."""
    return [{"train_id": did, "group": r.get("group"), "vram": r.get("vram")}
            for did, r in all_deploys().items()
            if r.get("kind") == "train" and r.get("status") == "queued"]


def get(deploy_id):
    return load_alloc().get("deploys", {}).get(deploy_id)


def all_deploys():
    return load_alloc().get("deploys", {})


def serve_gpus():
    """Set of GPU indices currently hosting a serve deploy."""
    return {r["gpu"] for r in all_deploys().values()
            if r.get("kind") == "serve" and r.get("gpu") is not None}


def mps_target_percent(gpu):
    """Dynamic MPS active-thread % for a training co-resident on this serve GPU,
    based on current inference SM utilization. Returns int 1..100.
    Idle inference -> high % (fill spare); busy inference -> low % (protect)."""
    sm = {g["index"]: g["sm"] for g in sample()}
    util = sm.get(gpu, 0)
    for threshold, pct in MPS_BANDS:
        if util < threshold:
            return pct
    return MPS_BANDS[-1][1]


def colocated_trains():
    """Running train deploys co-located on a serve GPU (MPS candidates).
    Returns list of {train_id, group, gpu, vram, mps_pct, serve_sm}."""
    sgpus = serve_gpus()
    if not sgpus:
        return []
    sm = {g["index"]: g["sm"] for g in sample()}
    out = []
    for did, r in all_deploys().items():
        if (r.get("kind") == "train" and r.get("status") == "running"
                and r.get("gpu") in sgpus):
            out.append({"train_id": did, "group": r.get("group"),
                        "gpu": r["gpu"], "vram": r.get("vram"),
                        "mps_pct": r.get("mps_pct"),
                        "serve_sm": sm.get(r["gpu"], -1)})
    return out


def set_mps_pct(deploy_id, pct):
    """Record the MPS % currently applied to a deploy (for rebalance diffing)."""
    with _LOCK:
        alloc = load_alloc()
        rec = alloc.setdefault("deploys", {}).get(deploy_id)
        if not rec:
            return
        rec["mps_pct"] = pct
        save_alloc(alloc)


def _group_gpus(group):
    """Return the set of GPU indices assigned to a group, or None if
    unrestricted (group unknown or no GPUs assigned → any GPU allowed)."""
    try:
        import groups as _groups
        st = _groups.load_state()
        g = st["groups"].get(group) if st else None
        if g:
            assigned = g.get("gpus") or []
            if assigned:
                return set(assigned)
    except Exception:
        pass
    return None


# --- placement ---
def place_train(deploy_id, group, vram_mb=None):
    """Pick the least-loaded GPU that fits vram_mb. Returns gpu int or None.
    Records the placement. None => no GPU fits (caller should queue/fail)."""
    vram = int(vram_mb) if vram_mb else DEFAULT_TRAIN_VRAM_MB
    sm = sample()
    if not sm:
        return None
    allowed = _group_gpus(group)
    if allowed is not None:
        sm = [g for g in sm if g["index"] in allowed]
        if not sm:
            return None
    sgpus = serve_gpus()
    candidates = [g for g in sm if g["vram_free"] >= vram]
    if not candidates:
        return None
    # sort: prefer GPUs without serve, then lower SM util, then more free VRAM
    candidates.sort(key=lambda g: (
        INFERENCE_GPU_PENALTY if g["index"] in sgpus else 0,
        g["sm"],
        -g["vram_free"],
    ))
    pick = candidates[0]["index"]
    _record(deploy_id, {"group": group, "kind": "train", "gpu": pick,
                        "status": "running", "vram": vram})
    return pick


def place_serve(deploy_id, group, gpu):
    """Record a statically pinned serve deploy. gpu is chosen at creation."""
    _record(deploy_id, {"group": group, "kind": "serve", "gpu": int(gpu),
                        "status": "running"})
    return int(gpu)


def gpu_for_deploy(dep, group):
    """Main entry: return CUDA_VISIBLE_DEVICES value for a deploy, or None.
    serve -> pinned dep['gpu'] (fallback: least-loaded if unset).
    train -> place_train()."""
    kind = (dep.get("kind") or "serve").lower()
    did = dep["id"]
    if kind == "train":
        return place_train(did, group, dep.get("vram"))
    # serve
    gpu = dep.get("gpu")
    if gpu is None or gpu == "":
        # not pinned — fall back to least-loaded (shouldn't happen per design)
        g = place_train(did, group, dep.get("vram") or DEFAULT_TRAIN_VRAM_MB)
        if g is not None:
            with _LOCK:
                alloc = load_alloc()
                alloc.setdefault("deploys", {})[did] = {
                    "group": group, "kind": "serve", "gpu": g, "status": "running"}
                save_alloc(alloc)
        return g
    return place_serve(did, group, gpu)


def relocate(deploy_id, group, vram_mb=None, exclude_gpu=None):
    """Pick a new GPU for an already-placed train deploy (migration target).
    Returns gpu int or None (None => no target, should evict/queue)."""
    vram = int(vram_mb) if vram_mb else DEFAULT_TRAIN_VRAM_MB
    sm = sample()
    if not sm:
        return None
    sgpus = serve_gpus()
    candidates = [g for g in sm
                  if g["vram_free"] >= vram and g["index"] != exclude_gpu]
    if not candidates:
        return None
    candidates.sort(key=lambda g: (
        INFERENCE_GPU_PENALTY if g["index"] in sgpus else 0,
        g["sm"],
        -g["vram_free"],
    ))
    pick = candidates[0]["index"]
    _record(deploy_id, {"group": group, "kind": "train", "gpu": pick,
                        "status": "running", "vram": vram})
    return pick


# --- pressure (hardware-sampled) ---
def pressured_serve_gpus():
    """Return list of serve GPU indices currently under sustained SM pressure.
    Uses _pressure_since to require PRESSURE_SUSTAINED_S consecutive seconds."""
    import time
    sm = {g["index"]: g["sm"] for g in sample()}
    now = time.time()
    result = []
    for gpu in serve_gpus():
        util = sm.get(gpu, 0)
        if util >= PRESSURE_SM_THRESHOLD:
            if gpu not in _pressure_since:
                _pressure_since[gpu] = now
            elif now - _pressure_since[gpu] >= PRESSURE_SUSTAINED_S:
                result.append(gpu)
        else:
            _pressure_since.pop(gpu, None)
    return result


def pressure_targets():
    """Return list of {train_id, group, from_gpu, vram} for train deploys that
    sit on a pressured serve GPU and should be migrated/evicted."""
    alloc = all_deploys()
    hot = set(pressured_serve_gpus())
    if not hot:
        return []
    out = []
    for did, r in alloc.items():
        if r.get("kind") == "train" and r.get("gpu") in hot:
            out.append({"train_id": did, "group": r.get("group"),
                        "from_gpu": r["gpu"], "vram": r.get("vram")})
    return out


def snapshot():
    """Human/JSON view for the UI: per-GPU load + what's placed there."""
    sm = sample()
    alloc = all_deploys()
    by_gpu = {}
    for did, r in alloc.items():
        by_gpu.setdefault(r.get("gpu"), []).append({
            "id": did, "group": r.get("group"), "kind": r.get("kind"),
            "status": r.get("status")})
    return {
        "gpus": [
            {"index": g["index"], "vram_used": g["vram_used"],
             "vram_free": g["vram_free"], "sm": g["sm"],
             "deploys": by_gpu.get(g["index"], []),
             "pressured": g["sm"] >= PRESSURE_SM_THRESHOLD}
            for g in sm
        ],
        "tunables": {
            "default_train_vram_mb": DEFAULT_TRAIN_VRAM_MB,
            "pressure_sm_threshold": PRESSURE_SM_THRESHOLD,
            "pressure_sustained_s": PRESSURE_SUSTAINED_S,
            "inference_gpu_penalty": INFERENCE_GPU_PENALTY,
            "mps_bands": [{"sm_below": t, "train_pct": p} for t, p in MPS_BANDS],
        },
        "colocated": [
            {"train_id": t["train_id"], "group": t["group"], "gpu": t["gpu"],
             "mps_pct": t["mps_pct"], "serve_sm": t["serve_sm"],
             "target_pct": mps_target_percent(t["gpu"])}
            for t in colocated_trains()
        ],
    }
