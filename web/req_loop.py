#!/usr/bin/env python3
"""Background loop: sample per-pod usage, maintain EWMA, and adjust k8s
requests **in-place** via the /resize subresource (k8s ≥1.33).  No restarts.

Every POLL_S seconds:
  1. Sample ``kubectl top pod`` → actual CPU/mem per group.
  2. Update EWMA per group.
  3. For each group with a Running pod: compute the EWMA-derived target
     request.  If it differs from the pod's current request by > DRIFT_PCT,
     patch the pod in-place (``kubectl patch pod --subresource resize``).
     The kubelet updates cgroups live; the scheduler sees the new value.
     The Deployment template is NOT touched (that would trigger a rollout) —
     it gets the EWMA-based request on the next user resize/restart via
     ``deployment_yaml``/``request_for``.

Logs to /opt/yatterra/req_loop.log.  Never raises out of the main loop.
"""
import json
import os
import subprocess
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import siteconf
import cpu_stats
import groups
import req_estimate
import logutil

POLL_S = 60
LOG = siteconf.path("req_loop.log")
DRIFT_PCT = 10      # resize if target differs from current by this %
COOLDOWN_S = 120    # min seconds between resizes for the same group
MIN_SAMPLES = 4     # EWMA warm-up before resizing
NS = siteconf.GROUP_NS
CONTAINER = siteconf.GROUP_CONTAINER


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _parse_cpu(s):
    try:
        s = str(s).strip()
        return int(s[:-1]) / 1000.0 if s.endswith("m") else float(s)
    except Exception:
        return 0.0


def _parse_mem_gi(s):
    try:
        s = str(s).strip()
        for u, f in {"Ki": 1 / (1024 * 1024), "Mi": 1 / 1024, "Gi": 1.0}.items():
            if s.endswith(u):
                return float(s[:-2]) * f
        return float(s) / (1024 ** 3)
    except Exception:
        return 0.0


def _kubectl(*args, timeout=15):
    try:
        r = subprocess.run(["kubectl", "-n", NS] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout or "", r.stderr or ""
    except Exception as e:
        return 99, "", str(e)


def sample_usage():
    """Return {group_name: (cpu_cores, mem_gi)} for Running pods."""
    try:
        rows = cpu_stats._per_group_raw()
    except Exception:
        return {}
    out = {}
    for r in rows:
        name = r.get("name", "")
        if name:
            out[name] = (_parse_cpu(r.get("cpu", "0")), _parse_mem_gi(r.get("mem", "0")))
    return out


def get_pod_name(name):
    """Return the running pod name for a group, or None."""
    rc, out, _ = _kubectl("get", "pod", "-l", f"app=group-{name}",
                          "-o", "jsonpath={.items[0].metadata.name}")
    if rc == 0 and out.strip():
        return out.strip()
    return None


def get_pod_request(pod):
    """Return (cpu_str, mem_str) of the pod's current requests, or (None,None)."""
    rc, out, _ = _kubectl("get", "pod", pod, "-o",
                          "jsonpath={.spec.containers[0].resources.requests}")
    if rc != 0:
        return None, None
    try:
        d = json.loads(out)
        return d.get("cpu"), d.get("memory")
    except Exception:
        return None, None


def resize_pod_inplace(pod, cpu_str, mem_str):
    """Patch pod requests via /resize subresource. Returns (ok, error)."""
    patch = json.dumps({"spec": {"containers": [
        {"name": CONTAINER, "resources": {"requests": {"cpu": cpu_str, "memory": mem_str}}}
    ]}})
    rc, out, err = _kubectl("patch", "pod", pod, "--subresource", "resize", "-p", patch)
    if rc == 0:
        return True, ""
    return False, err.strip() or out.strip()


def reconcile(name, g, sample, now):
    """Maybe in-place resize the pod's request. Returns True if resized."""
    limit_cpu = _parse_cpu(g.get("cpu", "1"))
    limit_mem = _parse_mem_gi(g.get("mem", "1Gi"))
    scpu, smem = sample
    e = req_estimate.update_ewma(name, scpu, smem)
    samples = e.get("samples", 0)
    if samples < MIN_SAMPLES:
        return False

    # target from EWMA
    t_cpu_str, t_mem_str, t_cpu, t_mem = req_estimate.reconcile_target(
        name, limit_cpu, limit_mem)

    # find running pod
    pod = get_pod_name(name)
    if not pod:
        return False

    cur_cpu_str, cur_mem_str = get_pod_request(pod)
    if not cur_cpu_str:
        return False
    cur_cpu = _parse_cpu(cur_cpu_str)
    if cur_cpu <= 0:
        return False

    # drift check
    if abs(t_cpu - cur_cpu) / cur_cpu < DRIFT_PCT / 100.0:
        return False

    # cooldown
    last = e.get("last_resize", 0)
    if now - last < COOLDOWN_S:
        return False

    # in-place resize — no restart
    ok, err = resize_pod_inplace(pod, t_cpu_str, t_mem_str)
    if ok:
        req_estimate.mark_resized(name, t_cpu_str, t_mem_str, now)
        direction = "lower" if t_cpu < cur_cpu else "raise"
        log(f"resize {name}: {direction} {cur_cpu_str}->{t_cpu_str} cpu, "
            f"{cur_mem_str}->{t_mem_str} mem (ewma={e.get('cpu_ewma',0):.2f}cpu "
            f"{e.get('mem_ewma',0):.2f}Gi) — in-place, no restart")
        return True
    else:
        log(f"resize {name}: FAILED {err[:120]}")
        return False


def main():
    log(f"req_loop start (poll={POLL_S}s, drift={DRIFT_PCT}%, cooldown={COOLDOWN_S}s, "
        f"min_samples={MIN_SAMPLES}) — in-place /resize, no restart")
    while True:
        try:
            now = time.time()
            state = groups.load_state()
            gmap = state.get("groups", {}) or {}
            usage = sample_usage()
            for name, g in gmap.items():
                try:
                    sample = usage.get(name, (0.0, 0.0))
                    reconcile(name, g, sample, now)
                except Exception as ex:
                    log(f"per-group error {name}: {ex!r}")
        except Exception as ex:
            log(f"loop error: {ex!r}\n{traceback.format_exc()}")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
