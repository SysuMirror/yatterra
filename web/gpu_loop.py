#!/usr/bin/env python3
"""GPU scheduler background loop: pressure-driven migration/eviction of train
deploys + re-queue of parked trains when a GPU frees.

Runs as a systemd service (root, so it can kubectl exec into pods). Polls every
POLL_S seconds. Per-deploy exceptions are caught so one bad deploy can't kill
the loop. Node-aware: every action is scoped to a single node (the group's
placement), so a train on spark is only ever migrated/parked against spark's own
GPUs.

Actions (per node):
  - pressured serve GPU + train co-located on it -> migrate to a cooler GPU
    (checkpoint + RESUME=true) if one fits; else park (evict to queued).
  - queued train + a GPU now fits -> re-place and resume.
  - dynamic MPS rebalance only on nodes that run an MPS daemon.

Logs to /opt/yatterra/gpu_loop.log.
"""
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import siteconf
import deploys
import scheduler
import logutil
import contract
import defer_queue

POLL_S = 5
LOG = siteconf.path("gpu_loop.log")

# hysteresis: target MPS % must be stable for this many consecutive polls
# before we restart a co-located train to avoid thrash at band boundaries.
MPS_STABLE_POLLS = 2
_mps_pending = {}   # (node, deploy_id) -> (target_pct, consecutive_count)


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _scan_nodes():
    """Nodes with any alloc state, plus the nodes of every queued train's group.
    Falls back to the default node so a single-node site is unchanged."""
    seen = set()
    try:
        for r in scheduler.all_deploys().values():
            seen.add(scheduler._rec_node(r))
    except Exception:
        pass
    try:
        for q in scheduler.queued_trains():
            seen.add(q.get("node") or scheduler.group_node(q.get("group")))
    except Exception:
        pass
    if not seen:
        seen.add(scheduler.DEFAULT_NODE)
    return sorted(seen)


def handle_pressure(node):
    targets = scheduler.pressure_targets(node)
    if not targets:
        return
    log(f"[{node}] pressure targets: {json.dumps(targets, ensure_ascii=False)}")
    for t in targets:
        tid, group, from_gpu, vram = t["train_id"], t["group"], t["from_gpu"], t["vram"]
        try:
            dep = deploys.get(group, tid)
            if not dep:
                scheduler.release(tid)
                continue
            target = scheduler.relocate(tid, group, vram, exclude_gpu=from_gpu,
                                        node=node)
            if target is not None:
                ok, msg = deploys.migrate(group, dep, target)
                log(f"[{node}] migrate {group}/{dep['name']} gpu{from_gpu}->gpu{target} ok={ok}")
            else:
                # P1-c: honour the flexibility contract — a train that is not
                # preemptable (e.g. critical, or explicit PREEMPT_OK=false) is
                # never parked.  Default preempt_ok for a train is True, so this
                # is a no-op until a group opts out.
                if not contract.preemptable(group, dep):
                    log(f"[{node}] skip park {group}/{dep['name']}: preempt_ok=false")
                    continue
                deploys.park(group, dep)
                log(f"[{node}] park {group}/{dep['name']} (no migration target)")
        except Exception as e:
            log(f"[{node}] pressure handle error {group}/{tid}: {e!r}\n{traceback.format_exc()}")


def handle_queued(node):
    # P1-c: let the defer queue release the delayable trains whose valley (or
    # deadline) has arrived, then place exactly those.  Non-deferrable trains
    # (the default) are handled below exactly as before.
    try:
        admitted = {a["deploy_id"] for a in defer_queue.admit()}
    except Exception as e:
        log(f"admit error: {e!r}")
        admitted = set()
    queued = scheduler.queued_trains(node)
    if not queued:
        return
    for q in queued:
        tid, group, vram = q["train_id"], q["group"], q["vram"]
        try:
            dep = deploys.get(group, tid)
            if not dep:
                scheduler.release(tid)
                continue
            # A delayable train only runs when admit() released it; otherwise we
            # keep it queued (tracked) and wait — do NOT place_train it.
            try:
                if defer_queue.should_defer(group, dep) and tid not in admitted:
                    defer_queue.enqueue(group, dep, by="gpu_loop")
                    continue
            except Exception:
                pass
            gpu = scheduler.place_train(tid, group, vram, node=node)
            if gpu is None:
                continue  # still no room
            ok, msg = deploys.migrate(group, dep, gpu)
            if ok:
                try:
                    defer_queue.mark_running(tid, gpu)
                except Exception:
                    pass
            log(f"[{node}] requeue {group}/{dep['name']} -> gpu{gpu} ok={ok}")
        except Exception as e:
            log(f"[{node}] requeue handle error {group}/{tid}: {e!r}")


def handle_mps_rebalance(node):
    """Dynamic MPS: adjust co-located training compute cap to fill idle inference
    compute (打满算力) or squeeze it when inference gets busy. Only restarts the
    train when the target band has been stable for MPS_STABLE_POLLS polls.
    Skipped entirely on nodes without an MPS daemon (e.g. spark)."""
    if not scheduler.has_mps(node):
        return
    trains = scheduler.colocated_trains(node)
    if not trains:
        _mps_pending.clear()
        return
    for t in trains:
        tid = t["train_id"]
        target = scheduler.mps_target_percent(t["gpu"], node)
        current = t["mps_pct"]
        if current == target:
            _mps_pending.pop((node, tid), None)
            continue
        # accumulate consecutive stability for this target
        prev = _mps_pending.get((node, tid))
        if prev and prev[0] == target:
            _mps_pending[(node, tid)] = (target, prev[1] + 1)
        else:
            _mps_pending[(node, tid)] = (target, 1)
        if _mps_pending[(node, tid)][1] < MPS_STABLE_POLLS:
            continue
        _mps_pending.pop((node, tid), None)
        try:
            dep = deploys.get(t["group"], tid)
            if not dep:
                continue
            ok, msg = deploys.restart_with_mps(t["group"], dep, t["gpu"], target)
            log(f"[{node}] mps rebalance {t['group']}/{dep['name']} gpu{t['gpu']} "
                f"{current}->{target}% (serve SM={t['serve_sm']}%) ok={ok}")
        except Exception as e:
            log(f"[{node}] mps rebalance error {t['group']}/{tid}: {e!r}\n{traceback.format_exc()}")


def main():
    log(f"gpu_loop start (poll={POLL_S}s, threshold={scheduler.PRESSURE_SM_THRESHOLD}%, "
        f"sustained={scheduler.PRESSURE_SUSTAINED_S}s, mps_bands={scheduler.MPS_BANDS})")
    while True:
        try:
            for node in _scan_nodes():
                handle_pressure(node)
                handle_mps_rebalance(node)
                handle_queued(node)
            try:
                defer_queue.reconcile()   # P1-c: close queue items gone from alloc
            except Exception as e:
                log(f"reconcile error: {e!r}")
        except Exception as e:
            log(f"loop error: {e!r}\n{traceback.format_exc()}")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
