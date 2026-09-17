#!/usr/bin/env python3
"""GPU scheduler background loop: pressure-driven migration/eviction of train
deploys + re-queue of parked trains when a GPU frees.

Runs as a systemd service (root, so it can kubectl exec into pods). Polls every
POLL_S seconds. Per-deploy exceptions are caught so one bad deploy can't kill
the loop.

Actions:
  - pressured serve GPU + train co-located on it -> migrate to a cooler GPU
    (checkpoint + RESUME=true) if one fits; else park (evict to queued).
  - queued train + a GPU now fits -> re-place and resume.

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

POLL_S = 5
LOG = siteconf.path("gpu_loop.log")

# hysteresis: target MPS % must be stable for this many consecutive polls
# before we restart a co-located train to avoid thrash at band boundaries.
MPS_STABLE_POLLS = 2
_mps_pending = {}   # deploy_id -> (target_pct, consecutive_count)


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def handle_pressure():
    targets = scheduler.pressure_targets()
    if not targets:
        return
    log(f"pressure targets: {json.dumps(targets, ensure_ascii=False)}")
    for t in targets:
        tid, group, from_gpu, vram = t["train_id"], t["group"], t["from_gpu"], t["vram"]
        try:
            dep = deploys.get(group, tid)
            if not dep:
                scheduler.release(tid)
                continue
            target = scheduler.relocate(tid, group, vram, exclude_gpu=from_gpu)
            if target is not None:
                ok, msg = deploys.migrate(group, dep, target)
                log(f"migrate {group}/{dep['name']} gpu{from_gpu}->gpu{target} ok={ok}")
            else:
                deploys.park(group, dep)
                log(f"park {group}/{dep['name']} (no migration target)")
        except Exception as e:
            log(f"pressure handle error {group}/{tid}: {e!r}\n{traceback.format_exc()}")


def handle_queued():
    queued = scheduler.queued_trains()
    if not queued:
        return
    for q in queued:
        tid, group, vram = q["train_id"], q["group"], q["vram"]
        try:
            dep = deploys.get(group, tid)
            if not dep:
                scheduler.release(tid)
                continue
            gpu = scheduler.place_train(tid, group, vram)
            if gpu is None:
                continue  # still no room
            ok, msg = deploys.migrate(group, dep, gpu)
            log(f"requeue {group}/{dep['name']} -> gpu{gpu} ok={ok}")
        except Exception as e:
            log(f"requeue handle error {group}/{tid}: {e!r}")


def handle_mps_rebalance():
    """Dynamic MPS: adjust co-located training compute cap to fill idle inference
    compute (打满算力) or squeeze it when inference gets busy. Only restarts the
    train when the target band has been stable for MPS_STABLE_POLLS polls."""
    trains = scheduler.colocated_trains()
    if not trains:
        _mps_pending.clear()
        return
    for t in trains:
        tid = t["train_id"]
        target = scheduler.mps_target_percent(t["gpu"])
        current = t["mps_pct"]
        if current == target:
            _mps_pending.pop(tid, None)
            continue
        # accumulate consecutive stability for this target
        prev = _mps_pending.get(tid)
        if prev and prev[0] == target:
            _mps_pending[tid] = (target, prev[1] + 1)
        else:
            _mps_pending[tid] = (target, 1)
        if _mps_pending[tid][1] < MPS_STABLE_POLLS:
            continue
        _mps_pending.pop(tid, None)
        try:
            dep = deploys.get(t["group"], tid)
            if not dep:
                continue
            ok, msg = deploys.restart_with_mps(t["group"], dep, t["gpu"], target)
            log(f"mps rebalance {t['group']}/{dep['name']} gpu{t['gpu']} "
                f"{current}->{target}% (serve SM={t['serve_sm']}%) ok={ok}")
        except Exception as e:
            log(f"mps rebalance error {t['group']}/{tid}: {e!r}\n{traceback.format_exc()}")


def main():
    log(f"gpu_loop start (poll={POLL_S}s, threshold={scheduler.PRESSURE_SM_THRESHOLD}%, "
        f"sustained={scheduler.PRESSURE_SUSTAINED_S}s, mps_bands={scheduler.MPS_BANDS})")
    while True:
        try:
            handle_pressure()
            handle_mps_rebalance()
            handle_queued()
        except Exception as e:
            log(f"loop error: {e!r}\n{traceback.format_exc()}")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
