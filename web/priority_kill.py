#!/usr/bin/env python3
"""Priority-aware pressure eviction loop for yatterra.

Why this exists
---------------
pressure_writer publishes host pressure (cpu/gpu/mem/bw) to
/mnt/sdb/shared/pressure/pressure.json every 2s. Applications read it and
self-degrade. But when pressure is critical, the infra layer must also *stop*
low-priority work to relieve the host. This loop does that, by priority:

  - Each sseinfra group carries a PRIORITY env var (critical | normal |
    best_effort) pushed by sse-deploy at deploy time. 1 module = 1 group = 1
    pod, so the group's PRIORITY is the module's priority.
  - When a relevant pressure metric crosses HIGH, stop best_effort programs
    (the ones that declared themselves expendable). When it crosses CRIT, also
    stop normal ones. critical is never touched.
  - "Relevant": a non-GPU program ignores gpu pressure (only cpu/mem/bw can
    evict it). Bucket effect: any one relevant metric over threshold triggers.
  - Victims are scored by priority_weight * (0.1 + resource_share): a
    low-priority high-mem program is evicted before a low-priority low-mem one.
  - When all metrics return to low and stay there RECOVER_S seconds, stopped
    programs are restarted in reverse eviction order (hysteresis + cooldown).

Standalone
----------
Like gpu_loop: sys.path.insert + import deploys/scheduler/groups, runs as a root
systemd service (root so it can kubectl exec into pods). Does NOT edit core
files. Recovery shells out to supervisorctl directly (same invocation as
deploys._supctl) rather than adding a public start() to deploys.py.

State: /opt/yatterra/priority_kill_state.json (root 600, atomic).
Log:   /opt/yatterra/priority_kill.log.

Tunables (env)
--------------
PRIORITY_KILL_POLL_S (5), PRIORITY_KILL_HIGH (0.80), PRIORITY_KILL_CRIT (0.92),
PRIORITY_KILL_RECOVER_LOW (0.40), PRIORITY_KILL_RECOVER_S (30),
PRIORITY_KILL_COOLDOWN_S (60), PRIORITY_KILL_STALE_S (30),
PRIORITY_KILL_FILE (/mnt/sdb/shared/pressure/pressure.json).
"""
import json
import os
import subprocess
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import siteconf     # noqa: E402
import deploys      # noqa: E402
import scheduler    # noqa: E402
import groups       # noqa: E402
import logutil      # noqa: E402

POLL_S = float(os.environ.get("PRIORITY_KILL_POLL_S", "5"))
THRESH_HIGH = float(os.environ.get("PRIORITY_KILL_HIGH", "0.80"))
THRESH_CRIT = float(os.environ.get("PRIORITY_KILL_CRIT", "0.92"))
RECOVER_LOW = float(os.environ.get("PRIORITY_KILL_RECOVER_LOW", "0.40"))
RECOVER_S = float(os.environ.get("PRIORITY_KILL_RECOVER_S", "30"))
COOLDOWN_S = float(os.environ.get("PRIORITY_KILL_COOLDOWN_S", "60"))
STALE_S = float(os.environ.get("PRIORITY_KILL_STALE_S", "30"))
PRESSURE_FILE = os.environ.get(
    "PRIORITY_KILL_FILE",
    os.path.join(siteconf.PRESSURE_DIR, "pressure.json"))

STATE_FILE = siteconf.path("priority_kill_state.json")
LOG = siteconf.path("priority_kill.log")

PRIO_WEIGHT = {"best_effort": 1.0, "normal": 0.5, "critical": 0.0}


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


# --- state --------------------------------------------------------------------

def load_state():
    if not os.path.exists(STATE_FILE):
        return {"stopped": [], "low_since": None, "cooldown": {}}
    try:
        with open(STATE_FILE) as f:
            d = json.load(f)
        d.setdefault("stopped", [])
        d.setdefault("low_since", None)
        d.setdefault("cooldown", {})
        return d
    except Exception:
        return {"stopped": [], "low_since": None, "cooldown": {}}


def save_state(st):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


# --- host / pod resource views ------------------------------------------------

def host_total_mem_mib():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                if k.strip() == "MemTotal":
                    return int(v.split()[0]) // 1024  # KiB -> MiB
    except Exception:
        pass
    return 1


def host_total_cores():
    n = os.cpu_count() or 1
    return n


def _parse_cpu(s):
    """'222m' -> 0.222 cores, '2' -> 2.0."""
    s = (s or "").strip()
    if not s:
        return 0.0
    if s.endswith("m"):
        try:
            return int(s[:-1]) / 1000.0
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _parse_mem_mib(s):
    """'5321Mi' -> 5321, '2Gi' -> 2048."""
    s = (s or "").strip()
    if not s:
        return 0.0
    units = {"Ki": 1 / 1024, "Mi": 1, "Gi": 1024, "Ti": 1024 * 1024}
    for u, mul in units.items():
        if s.endswith(u):
            try:
                return int(s[:-2]) * mul
            except ValueError:
                return 0.0
    try:
        return int(s) / (1024 * 1024)  # raw bytes -> MiB
    except ValueError:
        return 0.0


def pod_top_by_group():
    """Return {group_name: {"cpu": cores, "mem": mib}} via `kubectl top pod`.
    Pods are matched to groups by name prefix group-<name>- (group names contain
    dashes, so prefix-match against known groups, not split)."""
    out = {}
    try:
        r = subprocess.run(
            ["kubectl", "-n", groups.NS, "top", "pod", "--no-headers"],
            capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            return out
        # known group names for prefix matching
        try:
            known = list(groups.load_state().get("groups", {}).keys())
        except Exception:
            known = []
        known_sorted = sorted(known, key=len, reverse=True)  # longest first
        for line in (r.stdout or "").splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            pod, cpu, mem = parts[0], parts[1], parts[2]
            gname = None
            for g in known_sorted:
                if pod.startswith(f"group-{g}-"):
                    gname = g
                    break
            if not gname:
                continue
            out[gname] = {"cpu": _parse_cpu(cpu), "mem": _parse_mem_mib(mem)}
    except Exception:
        pass
    return out


def gpu_total_mem():
    """Return {gpu_index: total_vram_mib} from scheduler.sample()."""
    out = {}
    for g in scheduler.sample():
        out[g["index"]] = g["vram_used"] + g["vram_free"]
    return out


# --- pressure -----------------------------------------------------------------

def read_pressure():
    """Return pressure dict or None if missing/stale."""
    try:
        with open(PRESSURE_FILE) as f:
            p = json.load(f)
    except Exception:
        return None
    ts = p.get("ts")
    if ts is None or time.time() - float(ts) > STALE_S:
        return None
    return p


def group_priority(group):
    """Read PRIORITY env from the group's state (default normal)."""
    try:
        g = groups.load_state().get("groups", {}).get(group, {})
        return (g.get("env") or {}).get("PRIORITY", "normal") or "normal"
    except Exception:
        return "normal"


def is_gpu_program(rec):
    kind = (rec.get("kind") or "serve").lower()
    if kind == "train":
        return True
    return bool(rec.get("gpu") not in ("", None, "None"))


def relevant_metrics(rec):
    m = {"cpu", "mem", "bw"}
    if is_gpu_program(rec):
        m.add("gpu")
    return m


def pressure_value(metric, p):
    if metric == "gpu":
        a = p.get("gpu")
        b = p.get("gpu_mem")
        vals = [v for v in (a, b) if isinstance(v, (int, float))]
        return max(vals) if vals else 0.0
    v = p.get(metric)
    return v if isinstance(v, (int, float)) else 0.0


# --- one cycle ----------------------------------------------------------------

def build_candidates(p, top, gpu_tot, st):
    """Return list of candidate dicts for running deploys with their pressure
    tier and score. Only non-critical, currently-running, not-in-cooldown."""
    host_mem = host_total_mem_mib() or 1
    host_cores = host_total_cores() or 1
    now = time.time()
    cands = []
    for did, rec in scheduler.all_deploys().items():
        try:
            if rec.get("status") != "running":
                continue
            group = rec.get("group")
            if not group:
                continue
            prio = group_priority(group)
            if prio not in PRIO_WEIGHT or prio == "critical":
                continue
            # skip if in cooldown
            if did in st.get("cooldown", {}) and now < st["cooldown"][did]:
                continue
            # skip if already in stopped list
            if any(s["deploy_id"] == did for s in st.get("stopped", [])):
                continue
            rel = relevant_metrics(rec)
            vals = {m: pressure_value(m, p) for m in rel}
            maxval = max(vals.values()) if vals else 0.0
            if maxval >= THRESH_CRIT:
                tier = 2
            elif maxval >= THRESH_HIGH:
                tier = 1
            else:
                continue  # not pressured
            # tier 1 only best_effort; tier 2 also normal
            if tier == 1 and prio != "best_effort":
                continue
            # score: priority_weight * (0.1 + usage)
            usage = 0.0
            for m, v in vals.items():
                if v < THRESH_HIGH:
                    continue  # only count pressured metrics
                if m == "gpu":
                    vram = rec.get("vram")
                    gidx = rec.get("gpu")
                    tot = gpu_tot.get(gidx) if isinstance(gidx, int) else None
                    if vram and tot:
                        share = float(vram) / float(tot)
                    else:
                        share = 1.0
                elif m == "mem":
                    share = top.get(group, {}).get("mem", 0.0) / host_mem
                elif m == "cpu":
                    share = top.get(group, {}).get("cpu", 0.0) / host_cores
                else:  # bw
                    share = 1.0
                usage = max(usage, share)
            score = PRIO_WEIGHT[prio] * (0.1 + usage)
            hit = [m for m, v in vals.items() if v >= THRESH_HIGH]
            cands.append({
                "deploy_id": did, "group": group, "priority": prio,
                "tier": tier, "score": round(score, 4),
                "maxval": round(maxval, 3), "hit": hit,
                "kind": rec.get("kind"), "gpu": rec.get("gpu"),
                "vram": rec.get("vram"),
            })
        except Exception as e:
            log(f"candidate skip {did}: {e!r}")
    return cands


def supervisorctl_start(group, dep_id):
    """Restart a stopped supervised program. Shells out the same way as
    deploys._supctl (su -l cloud -c '~/.local/bin/supervisorctl ...') without
    touching core. Returns (rc, out+err)."""
    pod = deploys.resolve_pod(group)
    if not pod:
        return 1, "no pod"
    inner = (f"~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf "
             f"start deploy-{dep_id}")
    try:
        r = subprocess.run(
            ["kubectl", "-n", groups.NS, "exec", "-i", pod,
             "--", "su", "-l", "cloud", "-c", inner],
            capture_output=True, text=True, timeout=30)
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:
        return 1, repr(e)


def is_program_running(group, dep_id):
    """supervisorctl status deploy-<id> -> state token (RUNNING/STOPPED/...)."""
    pod = deploys.resolve_pod(group)
    if not pod:
        return False
    inner = (f"~/.local/bin/supervisorctl -c ~/deploy/supervisord.conf "
             f"status deploy-{dep_id}")
    try:
        r = subprocess.run(
            ["kubectl", "-n", groups.NS, "exec", "-i", pod,
             "--", "su", "-l", "cloud", "-c", inner],
            capture_output=True, text=True, timeout=15)
        return r.returncode == 0 and "RUNNING" in (r.stdout or "")
    except Exception:
        return False


def do_evict(cands, st, dry):
    """Pick victims by tier (highest tier first, then score desc), stop them."""
    # quota per tier
    quota = {2: 2, 1: 1}
    # order: tier desc, score desc
    cands.sort(key=lambda c: (-c["tier"], -c["score"]))
    stopped_now = []
    used = {1: 0, 2: 0}
    for c in cands:
        if used[c["tier"]] >= quota[c["tier"]]:
            continue
        used[c["tier"]] += 1
        group, did = c["group"], c["deploy_id"]
        dep = deploys.get(group, did)
        if not dep:
            log(f"evict skip {group}/{did}: deploy record gone")
            continue
        if dry:
            log(f"[DRY] would stop {group}/{dep['name']} prio={c['priority']} "
                f"tier={c['tier']} score={c['score']} hit={c['hit']}")
            stopped_now.append(c)
            continue
        try:
            ok, msg = deploys.stop(group, dep)
            log(f"evict {group}/{dep['name']} prio={c['priority']} "
                f"tier={c['tier']} score={c['score']} hit={c['hit']} ok={ok} "
                f"({msg})")
            if ok:
                stopped_now.append(c)
        except Exception as e:
            log(f"evict error {group}/{did}: {e!r}\n{traceback.format_exc()}")
    for c in stopped_now:
        st.setdefault("stopped", []).append({
            "deploy_id": c["deploy_id"], "group": c["group"],
            "name": c.get("kind", ""), "ts": time.time(),
            "score": c["score"], "metrics": c["hit"],
            "tier": c["tier"],
        })
    return len(stopped_now)


def all_metrics_low(p):
    for m in ("cpu", "gpu", "gpu_mem", "mem", "bw"):
        v = p.get(m)
        if isinstance(v, (int, float)) and v >= RECOVER_LOW:
            return False
    return True


def do_recover(p, st, dry):
    """If all metrics low for RECOVER_S, restart stopped programs in reverse."""
    now = time.time()
    if not all_metrics_low(p):
        st["low_since"] = None
        return 0
    if st.get("low_since") is None:
        st["low_since"] = now
        return 0
    if now - st["low_since"] < RECOVER_S:
        return 0
    stopped = st.get("stopped", [])
    if not stopped:
        return 0
    log(f"recovery: all metrics low for {RECOVER_S}s, restarting {len(stopped)}")
    recovered = 0
    for entry in reversed(list(stopped)):
        group, did = entry["group"], entry["deploy_id"]
        try:
            # still low for this group? (host-wide low here)
            if not all_metrics_low(p):
                break
            # still exists?
            dep = deploys.get(group, did)
            if not dep:
                log(f"recover skip {group}/{did}: record gone")
                continue
            if is_program_running(group, did):
                log(f"recover skip {group}/{dep['name']}: already running")
                recovered += 1  # count as done; remove below
                continue
            if dry:
                log(f"[DRY] would start {group}/{dep['name']}")
                recovered += 1
                continue
            rc, msg = supervisorctl_start(group, did)
            log(f"recover start {group}/{dep['name']} rc={rc} ({msg})")
            if rc == 0:
                recovered += 1
                st.setdefault("cooldown", {})[did] = now + COOLDOWN_S
        except Exception as e:
            log(f"recover error {group}/{did}: {e!r}")
    if recovered:
        # remove recovered entries (those whose deploy still exists / started)
        ids_done = set()
        # rebuild stopped without the recovered ones (last recovered entries)
        remaining = []
        # iterate original order, drop entries we recovered (match by id+ts)
        # simpler: drop entries whose deploy is now running or gone
        for entry in stopped:
            did = entry["deploy_id"]
            dep = deploys.get(entry["group"], did)
            if not dep:
                continue  # gone, drop
            if is_program_running(entry["group"], did):
                continue  # running, drop
            remaining.append(entry)
        st["stopped"] = remaining
        st["low_since"] = None  # reset; will re-arm if still low
    return recovered


def cycle(dry=False):
    p = read_pressure()
    if p is None:
        return  # no signal, fail-safe
    st = load_state()
    top = pod_top_by_group()
    gpu_tot = gpu_total_mem()
    cands = build_candidates(p, top, gpu_tot, st)
    if cands:
        tiers = sorted(set(c["tier"] for c in cands), reverse=True)
        log(f"pressure pressured candidates: {len(cands)} tiers={tiers} "
            f"top={top}")
    n_evict = do_evict(cands, st, dry)
    n_recov = do_recover(p, st, dry)
    if n_evict or n_recov or cands:
        save_state(st)


def main():
    import sys
    dry = "--once" in sys.argv[1:] or "--dry" in sys.argv[1:]
    once = "--once" in sys.argv[1:]
    log(f"priority_kill start (poll={POLL_S}s high={THRESH_HIGH} "
        f"crit={THRESH_CRIT} recover_low={RECOVER_LOW} recover_s={RECOVER_S}"
        f"{' DRY' if dry else ''})")
    while True:
        try:
            cycle(dry)
        except Exception as e:
            log(f"loop error: {e!r}\n{traceback.format_exc()}")
        if once:
            break
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
