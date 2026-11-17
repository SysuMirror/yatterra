#!/usr/bin/env python3
"""GPU scheduler for group deploys (node-aware).

Two classes:
  - serve (推理): statically pinned to a GPU chosen at deploy creation, within
    its node's GPU inventory. Never moved. It is the anchor; training yields to
    it, not the reverse.
  - train (训练): pooled. Placed on the least-loaded GPU *of the deploy's own
    node* that fits (VRAM hard constraint, SM util soft preference, penalty for
    GPUs that already host a serve deploy). Migrated/parked when a serve GPU
    comes under hardware pressure (SM util sustained high).

Multi-node: ``nodes.node_for(group)`` decides WHICH node a deploy runs on; this
module only chooses a GPU *index within that node's inventory* (``gpu_ids``).
Sampling is per-node:
  * the platform's own node (``nodes.DEFAULT_NODE``) — local nvidia-smi;
  * remote nodes (e.g. spark) — nvidia-smi over ``nodes.run_on`` (cached, the
    relay hop is slow).
Unified-memory nodes (GB10 / DGX Spark) report '[N/A]' memory from nvidia-smi,
so their memory figures come from the node's ``free -m`` instead: the single
pool IS the single GPU's budget.

MPS dynamic compute caps only apply to nodes whose profile runs an MPS daemon
(``nodes.has_mps``); other nodes co-locate without a compute cap and rely on
park/migrate instead.

Pressure signal is hardware sampling (nvidia-smi), per design.

State: <platform root>/gpu_alloc.json (root 600). Each record carries its
``node``; legacy records without one are assumed to be the default node. Single
platform process serializes placements via _LOCK.
"""
import json
import os
import subprocess
import threading
import time

import siteconf
import nodes

ALLOC_FILE = siteconf.path("gpu_alloc.json")

DEFAULT_NODE = nodes.DEFAULT_NODE

# --- tunables ---
DEFAULT_TRAIN_VRAM_MB = 12000      # default training VRAM need if deploy omits
PRESSURE_SM_THRESHOLD = 85         # serve GPU SM util % considered "under pressure"
PRESSURE_SUSTAINED_S = 10          # must hold threshold this long before acting
INFERENCE_GPU_PENALTY = 25         # added to sort key for GPUs hosting a serve
SAMPLE_TIMEOUT = 6
REMOTE_SAMPLE_TTL = 15             # cache remote nvidia-smi / free -m reads

# MPS dynamic compute caps for training co-resident on a serve GPU.
# Bands evaluated top-down: first threshold the inference SM is below => that %.
#   inference idle (SM<45)  -> train 85%  (fill spare compute, "打满算力")
#   inference medium (<75) -> train 50%  (share)
#   inference busy (>=75)  -> train 25%  (protect inference latency)
#   inference pressured (>=85 sustained) -> migrate/evict (gpu_loop handle_pressure)
MPS_BANDS = [(45, 85), (75, 50), (101, 25)]

_SMI_QUERY = ("nvidia-smi --query-gpu=index,memory.used,memory.free,"
              "utilization.gpu --format=csv,noheader,nounits")

_LOCK = threading.Lock()
_pressure_since = {}               # (node, gpu) -> epoch seconds when pressure seen
_remote_cache = {}                 # node -> (monotonic ts, [gpu dicts])
_mem_cache = {}                    # node -> (monotonic ts, {"total","used","free"})


# --- hardware sampling ---
def _num(cell):
    """nvidia-smi numeric cell → int, or 0 for N/A cells (GB10 reports
    '[N/A]' for memory.*; utilisation still works)."""
    try:
        return int(cell)
    except ValueError:
        return 0


def _parse_smi(stdout):
    out = []
    for line in (stdout or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            out.append({
                "index": int(parts[0]),
                "vram_used": _num(parts[1]),
                "vram_free": _num(parts[2]),
                "sm": _num(parts[3]),
            })
        except ValueError:
            continue
    return out


def _sample_local():
    try:
        r = subprocess.run(_SMI_QUERY.split(), capture_output=True, text=True,
                           timeout=SAMPLE_TIMEOUT)
    except Exception:
        return []
    if r.returncode != 0:
        return []
    return _parse_smi(r.stdout)


def _sample_remote(node):
    """nvidia-smi on a remote node via nodes.run_on, cached ~REMOTE_SAMPLE_TTL.
    Never raises; returns [] on failure."""
    now = time.monotonic()
    hit = _remote_cache.get(node)
    if hit and now - hit[0] < REMOTE_SAMPLE_TTL:
        return [dict(g) for g in hit[1]]
    try:
        ok, out = nodes.run_on(node, _SMI_QUERY, timeout=SAMPLE_TIMEOUT + 10)
    except Exception:
        ok, out = False, ""
    parsed = _parse_smi(out) if ok else []
    _remote_cache[node] = (now, parsed)
    return [dict(g) for g in parsed]


def _node_mem(node):
    """{total, used, free} MiB of a node's system memory (free col 7 = available,
    buffers/cache reclaimable). Cached; None on failure. Never raises."""
    now = time.monotonic()
    hit = _mem_cache.get(node)
    if hit and now - hit[0] < REMOTE_SAMPLE_TTL:
        return hit[1]
    val = None
    try:
        ok, out = nodes.run_on(node, "free -m | awk '/^Mem:/{print $2, $3, $7}'",
                               timeout=20)
        if ok:
            parts = (out or "").split()
            if len(parts) >= 3:
                val = {"total": int(parts[0]), "used": int(parts[1]),
                       "free": int(parts[2])}
    except Exception:
        val = None
    _mem_cache[node] = (now, val)
    return val


def sample(node=None):
    """Return list of {index, vram_used, vram_free, sm} for a node's GPUs.
    Empty list on any failure (never raises). Unified-memory nodes have their
    memory numbers taken from the node's system memory pool (nvidia-smi reports
    '[N/A]' there)."""
    node = node or DEFAULT_NODE
    out = _sample_local() if node == DEFAULT_NODE else _sample_remote(node)
    if out and nodes.unified_memory(node):
        mem = _node_mem(node)
        if mem:
            n = len(out)
            for g in out:
                # GB10 exposes one GPU owning the whole pool; if a node somehow
                # exposes several, split the pool evenly.
                g["vram_used"] = mem["used"] // n if n > 1 else mem["used"]
                g["vram_free"] = mem["free"] // n if n > 1 else mem["free"]
    return out


def num_gpus(node=None):
    return len(sample(node))


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


def _rec_node(r):
    """Node of an alloc record; legacy records (no node) are the default node."""
    return (r or {}).get("node") or DEFAULT_NODE


def _record(deploy_id, rec):
    with _LOCK:
        alloc = load_alloc()
        rec.setdefault("node", DEFAULT_NODE)
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


def queued_trains(node=None):
    """Train deploys parked waiting for a GPU (status=queued)."""
    return [{"train_id": did, "group": r.get("group"), "node": _rec_node(r),
             "vram": r.get("vram")}
            for did, r in all_deploys(node).items()
            if r.get("kind") == "train" and r.get("status") == "queued"]


def get(deploy_id):
    return load_alloc().get("deploys", {}).get(deploy_id)


def all_deploys(node=None):
    """All alloc records, or only those on ``node`` (None → every node)."""
    d = load_alloc().get("deploys", {})
    if node is None:
        return d
    return {k: v for k, v in d.items() if _rec_node(v) == node}


def group_node(group):
    """Node a group deploys to (nodes.node_for); default node when auto/unknown."""
    try:
        import groups as _groups
        st = _groups.load_state()
        g = st["groups"].get(group) if st else None
        n = nodes.node_for(g or {})
        if n:
            return n
    except Exception:
        pass
    return DEFAULT_NODE


def group_has_gpu(group):
    """Whether this pod was created with GPU devices (type == "gpu").

    Guards every placement path: a CPU / Windows / Android / NPU pod gets no
    ``NVIDIA_VISIBLE_DEVICES`` in its manifest, so booking a card for one of its
    deploys (or queueing a train job on a card it can never see) is wrong.
    Unknown group (lookup failed / pod already gone) keeps the legacy behaviour.
    """
    try:
        import groups as _groups
        st = _groups.load_state()
        g = (st.get("groups") or {}).get(group) if st else None
    except Exception:
        return True
    if not g:
        return True
    return g.get("type") == "gpu" and bool(g.get("gpus"))


def has_mps(node=None):
    """Whether a node runs an MPS daemon (dynamic compute caps are possible)."""
    return nodes.has_mps(node or DEFAULT_NODE)


def serve_gpus(node=None):
    """Set of GPU indices currently hosting a serve deploy (on ``node`` if given,
    else across every node — callers doing per-node work should pass a node)."""
    return {r["gpu"] for r in all_deploys(node).values()
            if r.get("kind") == "serve" and r.get("gpu") is not None}


def mps_target_percent(gpu, node=None):
    """Dynamic MPS active-thread % for a training co-resident on this serve GPU,
    based on current inference SM utilization. Returns int 1..100.
    Idle inference -> high % (fill spare); busy inference -> low % (protect)."""
    node = node or DEFAULT_NODE
    sm = {g["index"]: g["sm"] for g in sample(node)}
    util = sm.get(gpu, 0)
    for threshold, pct in MPS_BANDS:
        if util < threshold:
            return pct
    return MPS_BANDS[-1][1]


def colocated_trains(node=None):
    """Running train deploys co-located on a serve GPU (MPS candidates).
    Returns list of {train_id, group, gpu, vram, mps_pct, serve_sm}."""
    node = node or DEFAULT_NODE
    sgpus = serve_gpus(node)
    if not sgpus:
        return []
    sm = {g["index"]: g["sm"] for g in sample(node)}
    out = []
    for did, r in all_deploys(node).items():
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


def _group_gpus(group, node=None):
    """GPU indices a group may use on a node.

    With a node: always restricted to that node's inventory — the group's
    ``gpus`` ∩ node inventory, or the whole node inventory when the group is
    unrestricted / its ids don't fit this node.
    Without a node (legacy callers, e.g. forecast): the group's raw ``gpus``
    set, or None when unrestricted (any GPU allowed).
    """
    assigned = []
    try:
        import groups as _groups
        st = _groups.load_state()
        g = st["groups"].get(group) if st else None
        if g:
            assigned = g.get("gpus") or []
    except Exception:
        assigned = []
    if node:
        ids = set(nodes.gpu_ids(node))
        if assigned:
            want = set(assigned) & ids
            return want if want else ids
        return ids
    if assigned:
        return set(assigned)
    return None


def _pick(candidates, sgpus):
    """Shared placement sort: prefer GPUs without serve, then lower SM util,
    then more free VRAM. Mutates nothing; returns the chosen index or None."""
    if not candidates:
        return None
    candidates.sort(key=lambda g: (
        INFERENCE_GPU_PENALTY if g["index"] in sgpus else 0,
        g["sm"],
        -g["vram_free"],
    ))
    return candidates[0]["index"]


# --- placement ---
def place_train(deploy_id, group, vram_mb=None, node=None):
    """Pick the least-loaded GPU on ``node`` that fits vram_mb. Returns gpu int
    or None (None => no GPU fits; caller should queue/fail). Records the
    placement."""
    node = node or group_node(group)
    vram = int(vram_mb) if vram_mb else DEFAULT_TRAIN_VRAM_MB
    sm = sample(node)
    if not sm:
        return None
    allowed = _group_gpus(group, node)
    if allowed is not None:
        sm = [g for g in sm if g["index"] in allowed]
        if not sm:
            return None
    sgpus = serve_gpus(node)
    candidates = [g for g in sm if g["vram_free"] >= vram]
    pick = _pick(candidates, sgpus)
    if pick is None:
        return None
    _record(deploy_id, {"group": group, "kind": "train", "gpu": pick,
                        "status": "running", "vram": vram, "node": node})
    return pick


def place_serve(deploy_id, group, gpu, node=None):
    """Record a statically pinned serve deploy. gpu is chosen at creation."""
    node = node or group_node(group)
    _record(deploy_id, {"group": group, "kind": "serve", "gpu": int(gpu),
                        "status": "running", "node": node})
    return int(gpu)


def gpu_for_deploy(dep, group, node=None):
    """Main entry: return CUDA_VISIBLE_DEVICES value for a deploy, or None.
    The node comes from the caller (the group's placement); a pinned serve GPU
    that isn't in the node's inventory degrades to pool placement.
    serve -> pinned dep['gpu'] (fallback: least-loaded).
    train -> place_train()."""
    node = node or group_node(group)
    if not group_has_gpu(group):
        # CPU pod: no card is allocated to the container, nothing to place.
        return None
    kind = (dep.get("kind") or "serve").lower()
    did = dep["id"]
    if kind == "train":
        return place_train(did, group, dep.get("vram"), node)
    # serve
    gpu = dep.get("gpu")
    ids = set(nodes.gpu_ids(node))
    pinned_ok = False
    if gpu not in (None, ""):
        try:
            pinned_ok = int(gpu) in ids
        except (TypeError, ValueError):
            pinned_ok = False
    if not pinned_ok:
        # not pinned (or pinned to a GPU this node doesn't have) — fall back to
        # least-loaded placement within this node.
        g = place_train(did, group, dep.get("vram") or DEFAULT_TRAIN_VRAM_MB, node)
        if g is not None:
            _record(did, {"group": group, "kind": "serve", "gpu": g,
                          "status": "running", "node": node})
        return g
    return place_serve(did, group, gpu, node)


def relocate(deploy_id, group, vram_mb=None, exclude_gpu=None, node=None):
    """Pick a new GPU for an already-placed train deploy (migration target).
    Returns gpu int or None (None => no target, should evict/queue)."""
    node = node or group_node(group)
    vram = int(vram_mb) if vram_mb else DEFAULT_TRAIN_VRAM_MB
    sm = sample(node)
    if not sm:
        return None
    sgpus = serve_gpus(node)
    candidates = [g for g in sm
                  if g["vram_free"] >= vram and g["index"] != exclude_gpu]
    pick = _pick(candidates, sgpus)
    if pick is None:
        return None
    _record(deploy_id, {"group": group, "kind": "train", "gpu": pick,
                        "status": "running", "vram": vram, "node": node})
    return pick


# --- pressure (hardware-sampled) ---
def pressured_serve_gpus(node=None):
    """Return list of serve GPU indices on ``node`` currently under sustained SM
    pressure. Uses _pressure_since to require PRESSURE_SUSTAINED_S seconds."""
    node = node or DEFAULT_NODE
    sm = {g["index"]: g["sm"] for g in sample(node)}
    now = time.time()
    result = []
    for gpu in serve_gpus(node):
        util = sm.get(gpu, 0)
        key = (node, gpu)
        if util >= PRESSURE_SM_THRESHOLD:
            if key not in _pressure_since:
                _pressure_since[key] = now
            elif now - _pressure_since[key] >= PRESSURE_SUSTAINED_S:
                result.append(gpu)
        else:
            _pressure_since.pop(key, None)
    return result


def pressure_targets(node=None):
    """Return list of {train_id, group, from_gpu, vram, node} for train deploys
    that sit on a pressured serve GPU and should be migrated/evicted."""
    node = node or DEFAULT_NODE
    alloc = all_deploys(node)
    hot = set(pressured_serve_gpus(node))
    if not hot:
        return []
    out = []
    for did, r in alloc.items():
        if r.get("kind") == "train" and r.get("gpu") in hot:
            out.append({"train_id": did, "group": r.get("group"),
                        "from_gpu": r["gpu"], "vram": r.get("vram"),
                        "node": node})
    return out


def snapshot(node=None):
    """Human/JSON view for the UI: per-GPU load + what's placed there."""
    node = node or DEFAULT_NODE
    sm = sample(node)
    alloc = all_deploys(node)
    by_gpu = {}
    for did, r in alloc.items():
        by_gpu.setdefault(r.get("gpu"), []).append({
            "id": did, "group": r.get("group"), "kind": r.get("kind"),
            "status": r.get("status")})
    return {
        "node": node,
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
        "deploys": [
            {"id": did, "group": r.get("group"), "kind": r.get("kind"),
             "status": r.get("status"), "gpu": r.get("gpu")}
            for did, r in alloc.items()
        ],
        "queued_trains": queued_trains(node),
        "colocated": [
            {"train_id": t["train_id"], "group": t["group"], "gpu": t["gpu"],
             "mps_pct": t["mps_pct"], "serve_sm": t["serve_sm"],
             "target_pct": mps_target_percent(t["gpu"], node)}
            for t in colocated_trains(node)
        ],
    }
