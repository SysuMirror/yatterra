#!/usr/bin/env python3
"""Background loop: sample per-pod usage, maintain EWMA, and adjust k8s
requests **in-place** via the /resize subresource (k8s ≥1.33).  No restarts.

Every POLL_S seconds:
  1. Sample per-group CPU/mem (``cgroup_stats`` if available, else ``top pod``).
  2. Sample each group's persistent home usage from the hostPath.
  3. Update EWMA per group.
  4. For each group with a Running pod: compute the EWMA-derived target
     request.  If it differs from the pod's current request by > DRIFT_PCT,
     patch the pod in-place (``kubectl patch pod --subresource resize``).
     The kubelet updates cgroups live; the scheduler sees the new value.
  5. For each group with NO pod at all: if the Deployment exists, align its
     pod-template requests to the current target so a later involuntary
     recreate doesn't resurrect the stale, over-reserved template value.
     Patching a template only rolls out when a pod exists, so with no pod this
     is disruption-free; it is skipped whenever a pod (Running or Pending) is
     present, to never cause a surprise rollout.  Storage requests stay
     template-time only (Kubernetes cannot resize ephemeral-storage in place).

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

# Absolute deadbands: a change smaller than this is noise, not signal, so we
# don't patch even when the relative drift exceeds DRIFT_PCT.  A near-idle pod's
# cgroup CPU rate is noisy at the few-tens-of-millicores level, so without an
# absolute floor it round-trips its request up and down every cooldown for no
# benefit (all the while issuing a /resize call).  Both gates must pass on the
# same dimension (see ``_moved_enough``).
CPU_DEADBAND = 0.05        # cores  (50m)
MEM_DEADBAND_GI = 0.0625   # GiB    (64Mi)
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


def _du_gi(path):
    """Return apparent disk usage for a group home, or zero on failure."""
    try:
        total = 0
        for root, dirs, files in os.walk(path):
            for entry in files:
                try:
                    total += os.stat(os.path.join(root, entry), follow_symlinks=False).st_blocks * 512
                except OSError:
                    pass
        return total / (1024 ** 3)
    except OSError:
        return 0.0


def _kubectl(*args, timeout=15):
    try:
        r = subprocess.run(["kubectl", "-n", NS] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout or "", r.stderr or ""
    except Exception as e:
        return 99, "", str(e)


def sample_usage():
    """Return {group_name: (cpu_cores, mem_gi)} for Running pods.

    Prefers ``cgroup_stats.sample_groups()`` (instantaneous cgroup v2 counters,
    no metrics-server lag) and falls back to the ``kubectl top pod`` path when
    cgroup accounting is unavailable.  ``cgroup_stats`` is imported lazily so a
    missing/broken module degrades gracefully instead of breaking the loop.
    """
    try:
        import cgroup_stats
        rows = cgroup_stats.sample_groups()
        if rows:
            return {str(k): (float(v[0]), float(v[1])) for k, v in rows.items()}
    except Exception:
        pass
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


def sample_storage_usage(gmap):
    """Return {group_name: persistent-home usage in Gi}.

    The group home is a hostPath on the large data disk, so this is separate
    from the container writable layer represented by ephemeral-storage.
    """
    return {
        name: _du_gi(os.path.join(groups.GROUP_DATA_ROOT, name, "home"))
        for name in gmap
    }


def get_pod_name(name):
    """Return ``(pod_name_or_None, ok)`` for a group's pod.

    ``ok`` is False when the query itself failed (kubectl/API error, timeout),
    so a caller can tell "the group genuinely has no pod" (ok=True, pod=None)
    apart from "couldn't ask" (ok=False).  Collapsing the two would let a
    transient kubectl error masquerade as an empty group and let the
    deployment-template sync fire while a pod is actually Running.

    The jsonpath uses ``items[*]`` deliberately: ``items[0]`` errors (rc!=0) on
    an *empty* list, which would be indistinguishable from a real query failure
    and would silently disable the no-pod template sync.
    """
    rc, out, _ = _kubectl("get", "pod", "-l", f"app=group-{name}",
                          "-o", "jsonpath={.items[*].metadata.name}")
    if rc != 0:
        return None, False
    names = out.split()
    return (names[0] if names else None), True


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


def get_deployment(name):
    """Return the deployment name 'group-<name>' if it exists, else None."""
    rc, out, _ = _kubectl("get", "deployment", f"group-{name}",
                          "-o", "jsonpath={.metadata.name}")
    if rc == 0 and out.strip():
        return out.strip()
    return None


def get_deployment_requests(name):
    """Return (cpu_str, mem_str) of the deployment pod-template requests.

    (None, None) when the deployment or its requests are missing.
    """
    rc, out, _ = _kubectl("get", "deployment", f"group-{name}", "-o",
                          "jsonpath="
                          "{.spec.template.spec.containers[0].resources.requests}")
    if rc != 0:
        return None, None
    try:
        d = json.loads(out)
        return d.get("cpu"), d.get("memory")
    except Exception:
        return None, None


def patch_deployment_requests(name, cpu_str, mem_str):
    """Strategic-merge-patch the deployment pod-template requests. (ok, error).

    ``--type strategic`` is required, not cosmetic: ``containers`` is a
    strategic-merge list keyed by ``name``, so a single-container payload merges
    into the existing container by name and preserves its image/command/env.
    With ``--type merge`` (RFC-7386 JSON merge) the list would be replaced
    wholesale, dropping ``image`` → the API rejects the patch
    ("containers[0].image: Required value").

    Ephemeral-storage is deliberately left alone: the group home is a hostPath,
    so its byte count must never become a scheduler reservation (see
    ``req_estimate.request_for``).
    """
    patch = json.dumps({"spec": {"template": {"spec": {"containers": [
        {"name": CONTAINER, "resources": {"requests": {"cpu": cpu_str, "memory": mem_str}}}
    ]}}}})
    rc, out, err = _kubectl("patch", "deployment", f"group-{name}",
                            "--type", "strategic", "-p", patch)
    if rc == 0:
        return True, ""
    return False, err.strip() or out.strip()


def _moved_enough(cur_cpu, cur_mem, new_cpu, new_mem):
    """True when a request change clears DRIFT_PCT *and* the absolute deadband.

    Both gates must pass on the *same* dimension before the change is worth a
    patch: a large relative jump that amounts to a few millicores is noise on a
    near-idle pod, while a large absolute jump on a big reservation already
    clears the relative gate on its own.
    """
    dcpu = abs(new_cpu - cur_cpu)
    dmem = abs(new_mem - cur_mem)
    cpu_moved = cur_cpu > 0 and dcpu / cur_cpu >= DRIFT_PCT / 100.0 and dcpu >= CPU_DEADBAND
    mem_moved = cur_mem > 0 and dmem / cur_mem >= DRIFT_PCT / 100.0 and dmem >= MEM_DEADBAND_GI
    return cpu_moved or mem_moved


def sync_deployment_template(name, cpu_str, mem_str):
    """Align a Deployment's pod-template requests to the target when no pod exists.

    Only reached when the group has no pod, so a merge-patch cannot roll out.
    Patches only when ``_moved_enough`` says the template really drifted from
    the target (relative drift *and* absolute deadband) so a steady state
    doesn't re-patch every poll.  Returns True if patched; never raises.
    """
    try:
        if not get_deployment(name):
            return False
        cur_cpu_str, cur_mem_str = get_deployment_requests(name)
        if not cur_cpu_str or not cur_mem_str:
            return False
        cur_cpu = _parse_cpu(cur_cpu_str)
        cur_mem = _parse_mem_gi(cur_mem_str)
        new_cpu = _parse_cpu(cpu_str)
        new_mem = _parse_mem_gi(mem_str)
        if cur_cpu <= 0 or cur_mem <= 0:
            return False
        if not _moved_enough(cur_cpu, cur_mem, new_cpu, new_mem):
            return False
        ok, err = patch_deployment_requests(name, cpu_str, mem_str)
        if ok:
            log(f"template sync {name}: {cur_cpu_str}->{cpu_str} cpu, "
                f"{cur_mem_str}->{mem_str} mem (no pod; template only, no rollout)")
            return True
        log(f"template sync {name}: FAILED {err[:120]}")
        return False
    except Exception as ex:
        log(f"template sync {name}: error {ex!r}")
        return False


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
    scpu, smem, sstorage = sample
    e = req_estimate.update_ewma(name, scpu, smem, sstorage)
    samples = e.get("samples", 0)
    if samples < MIN_SAMPLES:
        return False

    # target from EWMA
    t_cpu_str, t_mem_str, _t_storage_str, t_cpu, t_mem, t_storage = req_estimate.reconcile_target(
        name, limit_cpu, limit_mem,
        req_estimate.parse_storage_gi(g.get("storage", "1Gi")))

    # find running pod. ok=False means the query failed — do NOT treat it as
    # an empty group (that could patch a live Deployment's template).
    pod, ok = get_pod_name(name)
    if not ok:
        return False
    if not pod:
        # No pod at all → keep the Deployment template in sync (a template-only
        # patch cannot roll out).  If a pod exists (Running *or* Pending) we never
        # touch the template, to avoid triggering a surprise rollout.
        sync_deployment_template(name, t_cpu_str, t_mem_str)
        return False

    cur_cpu_str, cur_mem_str = get_pod_request(pod)
    if not cur_cpu_str:
        return False
    cur_cpu = _parse_cpu(cur_cpu_str)
    cur_mem = _parse_mem_gi(cur_mem_str)
    if cur_cpu <= 0 or cur_mem <= 0:
        return False

    # drift check — must clear both the relative drift and an absolute deadband
    # so near-idle pods don't churn their request on sampling noise
    if not _moved_enough(cur_cpu, cur_mem, t_cpu, t_mem):
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
            f"{e.get('mem_ewma',0):.2f}Gi; storage={e.get('storage_ewma',0):.2f}Gi "
            f"→ next template {req_estimate.fmt_storage_gi(t_storage)}) — in-place, no restart")
        return True
    else:
        log(f"resize {name}: FAILED {err[:120]}")
        return False


def main():
    log(f"req_loop start (poll={POLL_S}s, drift={DRIFT_PCT}%, cooldown={COOLDOWN_S}s, "
        f"min_samples={MIN_SAMPLES}, deadband={int(CPU_DEADBAND*1000)}m/"
        f"{int(MEM_DEADBAND_GI*1024)}Mi) — in-place /resize, no restart")
    while True:
        try:
            now = time.time()
            state = groups.load_state()
            gmap = state.get("groups", {}) or {}
            usage = sample_usage()
            storage_usage = sample_storage_usage(gmap)
            for name, g in gmap.items():
                try:
                    cpu_mem = usage.get(name, (0.0, 0.0))
                    sample = (*cpu_mem, storage_usage.get(name, 0.0))
                    reconcile(name, g, sample, now)
                except Exception as ex:
                    log(f"per-group error {name}: {ex!r}")
        except Exception as ex:
            log(f"loop error: {ex!r}\n{traceback.format_exc()}")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
