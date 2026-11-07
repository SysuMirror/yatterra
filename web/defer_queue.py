#!/usr/bin/env python3
"""Defer queue: hold delayable **train** deploys until a forecast valley, then
admit them with a deadline-aware, capacity-gated decision (P1-c).

Only ``train`` is ever enqueued — a ``serve`` deploy is pinned to its card and
never moves (``scheduler.py`` header).  Nothing here starts a daemon: the queue
is hosted by the existing ``gpu_loop`` 5-second loop (``admit`` in
``handle_queued``, valley gate in ``handle_pressure``).

Admission is deliberately conservative and *default-off*: a deploy enters the
queue only when its contract says ``DEFER_OK=true`` (default ``False`` for every
kind — see ``contract.py``), so an un-opted-in platform behaves exactly as
before.  When the forecast is missing or stale the queue degrades to the current
reactive frame (admit as soon as a card fits) and bumps ``forecast_fallback``.

Supply model (closes plan U1/C3): ``S_t`` is *today's* free VRAM on the group's
allowed cards (``forecast.free_mib``), not a forecast of future free VRAM —
the deferred trains are themselves the future consumers and other consumers are
unknowable.  The forecast supplies only the *timing* (wait for the valley).
The safety margin is therefore a confidence-scaled headroom over the item's
VRAM need, not the demand-unit quantile ``forecast.error_quantile`` (which is
recorded for observability only — its units are cores, not MiB).

Admission runs an EDF pass with a *per-round* occupancy ledger ``R_t``: a
commit reserves ``need + margin`` for the rest of the round, so two items can
never claim the same free MiB (``free_mib`` comes from the live GPU frame,
which does not yet reflect commits made microseconds ago).  A valley gate that
never opens cannot starve an item forever: after ``MAX_DEFER_S`` (env
``YATTERRA_DEFER_MAX_S``, wall clock, 0 = off) it is admitted like a
deadline-forced start.  Per-group ``per_group`` phase overrides in
``timeline.json`` win over the platform phase.

State lives in ``defer_queue.json`` (``schema=1``): authoritative for the
deferred lifecycle, double-written against ``gpu_alloc.json`` (authoritative
for placement) and ``deploys.last_status`` (human mirror).  Cross-process safe
via an flock on ``defer_queue.json.lock``.  A blocked-but-unchanged round does
not rewrite the file (only the counters are flushed, at most every
``COUNTER_FLUSH_S``).  Never raises.
"""
import contextlib
import fcntl
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import siteconf
import logutil
import contract

QUEUE_FILE = os.environ.get("YATTERRA_DEFER_QUEUE") or siteconf.path("defer_queue.json")
LOCK_FILE = QUEUE_FILE + ".lock"
LOG = os.environ.get("YATTERRA_DEFER_LOG") or siteconf.path("defer_queue.log")

SCHEMA = 1
MAX_ITEMS = 500           # cap on live queue depth
RING_LEN = 200            # bounded decision/lifecycle history

FORECAST_STALE_S = 3 * 3600   # age beyond this -> reactive fallback (D5 naming)

# confidence-scaled headroom over the item's VRAM need
MARGIN_FRAC = {"high": 0.05, "med": 0.10, "low": 0.20}
DEFAULT_MARGIN_FRAC = 0.10
DEADLINE_SLACK_S = 120        # must be able to start this long before the deadline

DEFAULT_EST_DURATION_S = 3600
DEADLINE_MISS_POLICY = os.environ.get("YATTERRA_DEADLINE_MISS_POLICY", "run_anyway")

# Starvation guard: a delayable train with no (or a soft) deadline would wait
# for a valley *forever* if the published phase never reads ``valley`` (e.g. a
# permanently flat forecast).  After this long it is admitted regardless of the
# valley clock, exactly like a deadline-forced start.  0 disables the guard.
try:
    MAX_DEFER_S = int(os.environ.get("YATTERRA_DEFER_MAX_S") or 24 * 3600)
except (TypeError, ValueError):
    MAX_DEFER_S = 24 * 3600
# While the queue is blocked but otherwise unchanged (steady ``await-valley``),
# skip the per-tick rewrite; flush the decision counters at least this often.
COUNTER_FLUSH_S = 300

_TERMINAL = ("done", "missed", "cancelled")
_LIVE = ("queued", "deferred", "running")
_LOCK = threading.RLock()


def log(msg):
    try:
        logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


@contextlib.contextmanager
def _locked():
    """Cross-process exclusive lock (flock) + in-process re-entrant guard."""
    with _LOCK:
        try:
            f = open(LOCK_FILE, "a+")
        except OSError:
            yield          # unwritable lock dir: proceed unguarded rather than die
            return
        try:
            fcntl.flock(f, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(f, fcntl.LOCK_UN)
            except Exception:
                pass
            f.close()


def _empty():
    return {"schema": SCHEMA, "generated_ts": int(time.time()),
            "counters": {}, "items": {}, "history": []}


def _load():
    """Parsed state, or a fresh empty one on missing/corrupt (never raises)."""
    try:
        with open(QUEUE_FILE) as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return _empty()
    except FileNotFoundError:
        return _empty()
    except Exception:
        return _empty()
    d.setdefault("schema", SCHEMA)
    d.setdefault("counters", {})
    d.setdefault("items", {})
    d.setdefault("history", [])
    if not isinstance(d["items"], dict):
        d["items"] = {}
    if not isinstance(d["history"], list):
        d["history"] = []
    return d


def _save(d):
    """Atomic replace; best-effort 0640 to match the other platform data files."""
    d["schema"] = SCHEMA
    d["generated_ts"] = int(time.time())
    tmp = QUEUE_FILE + ".tmp"
    try:
        os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(d, f, ensure_ascii=False, sort_keys=True)
        try:
            os.chmod(tmp, 0o640)
        except OSError:
            pass
        os.replace(tmp, QUEUE_FILE)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _bump(d, key, n=1):
    d["counters"][key] = int(d["counters"].get(key, 0)) + n


def _push_history(d, item, action):
    d["history"].append({"ts": int(time.time()), "deploy_id": item.get("deploy_id"),
                         "group": item.get("group"), "action": action,
                         "state": item.get("state")})
    if len(d["history"]) > RING_LEN:
        del d["history"][: len(d["history"]) - RING_LEN]


# ── contract (thin wrapper; single impl lives in contract.py, per ruling D1) ──
def _env_val(group, dep, key):
    try:
        return contract._sources(group, dep).get(key.upper())
    except Exception:
        return None


def _est_duration(group, dep):
    raw = None
    if isinstance(dep, dict):
        raw = dep.get("est_duration_s")
    if raw is None:
        raw = _env_val(group, dep, "EST_DURATION_S")
    if raw is None:
        return DEFAULT_EST_DURATION_S
    try:
        v = int(float(raw))
        return v if v > 0 else DEFAULT_EST_DURATION_S
    except (TypeError, ValueError):
        return DEFAULT_EST_DURATION_S


def _deadline_kind(group, dep):
    raw = _env_val(group, dep, "DEADLINE_KIND")
    return "hard" if str(raw or "").strip().lower() == "hard" else "soft"


def contract_of(group, dep=None):
    """``contract.contract_for`` + the P1-c ``EST_DURATION_S`` / ``DEADLINE_KIND``.

    Thin wrapper only (ruling D1); the parsing/defaults live in ``contract``.
    Never raises.
    """
    try:
        c = dict(contract.contract_for(group, dep))
    except Exception:
        c = {"defer_ok": False, "preempt_ok": False, "deadline": None}
    c["est_dur_s"] = _est_duration(group, dep)
    c["deadline_kind"] = _deadline_kind(group, dep)
    return c


def should_defer(group, dep):
    """True iff this deploy belongs in the defer queue: a delayable train."""
    kind = ((dep or {}).get("kind") or "serve").lower()
    if kind != "train":
        return False
    try:
        return bool(contract_of(group, dep)["defer_ok"])
    except Exception:
        return False


# ── lifecycle ──────────────────────────────────────────────────────────────
def _item(group, dep, by):
    c = contract_of(group, dep)
    try:
        vram = int(dep.get("vram") or 0) or None
    except (TypeError, ValueError):
        vram = None
    return {
        "deploy_id": dep.get("id"),
        "group": group,
        "name": dep.get("name"),
        "kind": (dep.get("kind") or "serve").lower(),
        "vram_mb": vram,
        "est_dur_s": c["est_dur_s"],
        "deadline_ts": c.get("deadline"),
        "deadline_kind": c["deadline_kind"],
        "defer_ok": bool(c.get("defer_ok")),
        "preempt_ok": bool(c.get("preempt_ok")),
        "priority": dep.get("priority"),
        "enqueued_ts": int(time.time()),
        "earliest_start": int(dep.get("earliest_start") or 0),
        "by": by,
        "state": "queued",
        "gpu": None,
        "attempts": 0,
        "last_decision": None,
    }


def enqueue(group, dep, *, by="api"):
    """Add a delayable train to the queue.  Idempotent for live items.

    A deploy already in a non-terminal state is returned unchanged (no
    duplicate, no counter churn).  A terminal/absent deploy creates a fresh
    item.  Never raises (returns ``None`` on a malformed deploy).
    """
    if not isinstance(dep, dict) or not dep.get("id"):
        return None
    with _locked():
        d = _load()
        did = dep["id"]
        cur = d["items"].get(did)
        if cur and cur.get("state") in _LIVE:
            _bump(d, "enqueue_idempotent")
            _save(d)
            return cur
        if len(d["items"]) >= MAX_ITEMS:
            _bump(d, "enqueue_rejected")
            _save(d)
            log(f"enqueue rejected {group}/{did}: queue full ({MAX_ITEMS})")
            return None
        it = _item(group, dep, by)
        d["items"][did] = it
        _bump(d, "enqueued")
        _save(d)
        log(f"enqueue {group}/{it.get('name')} id={did} vram={it['vram_mb']} "
            f"deadline={it['deadline_ts']} by={by}")
        return it


def remove(deploy_id, reason="", state="cancelled"):
    """Drop a deploy from the queue (stop/delete).  Idempotent."""
    with _locked():
        d = _load()
        it = d["items"].get(deploy_id)
        if not it:
            return None
        it["state"] = state if state in _TERMINAL else "cancelled"
        it["last_decision"] = {"ts": int(time.time()), "action": "remove",
                               "reason": reason or it["state"]}
        _push_history(d, it, "remove")
        del d["items"][deploy_id]
        _bump(d, "removed")
        _save(d)
        log(f"remove {it.get('group')}/{deploy_id} state={state} reason={reason}")
        return it


def mark_running(deploy_id, gpu):
    with _locked():
        d = _load()
        it = d["items"].get(deploy_id)
        if not it:
            return None
        it["state"] = "running"
        it["gpu"] = gpu
        it["last_decision"] = {"ts": int(time.time()), "action": "running",
                               "reason": f"gpu{gpu}"}
        _bump(d, "started")
        _save(d)
        return it


def mark_done(deploy_id):
    return _finish(deploy_id, "done", "")


def mark_missed(deploy_id, reason=""):
    return _finish(deploy_id, "missed", reason)


def _finish(deploy_id, state, reason):
    with _locked():
        d = _load()
        it = d["items"].get(deploy_id)
        if not it:
            return None
        it["state"] = state
        it["last_decision"] = {"ts": int(time.time()), "action": state,
                               "reason": reason}
        _push_history(d, it, state)
        del d["items"][deploy_id]
        _bump(d, state)
        _save(d)
        return it


# ── reads ─────────────────────────────────────────────────────────────────
def pending(now=None):
    """Live items (``queued``/``deferred``/``running``), newest-enqueued first."""
    d = _load()
    out = [it for it in d["items"].values() if it.get("state") in _LIVE]
    out.sort(key=lambda it: it.get("enqueued_ts") or 0, reverse=True)
    return out


def snapshot(now=None):
    """Counters + per-state counts + live items (for API/UI)."""
    d = _load()
    by_state = {}
    for it in d["items"].values():
        s = it.get("state") or "?"
        by_state[s] = by_state.get(s, 0) + 1
    return {"schema": d.get("schema", SCHEMA), "generated_ts": d.get("generated_ts"),
            "counters": dict(d.get("counters", {})), "by_state": by_state,
            "pending": sorted(d["items"].values(),
                              key=lambda it: it.get("enqueued_ts") or 0),
            "history_len": len(d.get("history", []))}


def supply(group=None, now=None):
    """Thin compat read (ruling C2): today's best single-card free VRAM (MiB),
    or ``None`` when capacity is unavailable."""
    try:
        import forecast
        return forecast.free_mib(group, now)
    except Exception:
        return None


# ── admission ─────────────────────────────────────────────────────────────
def _forecast_ok(now):
    try:
        import forecast
        age = forecast.age_s(now)
        return age is not None and age <= FORECAST_STALE_S
    except Exception:
        return False


def _confidence(now):
    try:
        import timeline
        return (timeline.read() or {}).get("confidence") or "med"
    except Exception:
        return "med"


def _margin_mib(need_mib, conf):
    frac = MARGIN_FRAC.get(str(conf).lower(), DEFAULT_MARGIN_FRAC)
    return int(need_mib * frac)


def _need_mib(it, forecast=None):
    """The item's VRAM need, falling back to the platform's train default."""
    try:
        need = int(it.get("vram_mb") or 0)
    except (TypeError, ValueError):
        need = 0
    if need > 0:
        return need
    return int(getattr(forecast, "DEFAULT_TRAIN_VRAM_MB", 12000))


def _group_valley(group, now):
    """Is this group in a valley now?  A published ``per_group`` override wins,
    else the platform phase (``timeline.is_valley``)."""
    try:
        import timeline
    except Exception:
        return False
    try:
        pg = (timeline.read() or {}).get("per_group") or {}
        p = (pg.get(group) or {}).get("phase")
        if p in ("peak", "shoulder", "valley"):
            return p == "valley"
    except Exception:
        pass
    try:
        return bool(timeline.is_valley(now))
    except Exception:
        return False


def _valley_ok(it, now, favail):
    """May this item start *now* w.r.t. the valley clock?

    In fallback (no forecast) the queue is reactive: any time is fine, matching
    today's behaviour.  Otherwise wait for a valley, unless the deadline forces
    a start (we must be able to finish before it) or the item has been waiting
    longer than ``MAX_DEFER_S`` (no starvation).
    """
    if not favail:
        return True, "reactive-fallback"
    if _group_valley(it.get("group"), now):
        return True, "valley"
    dl = it.get("deadline_ts")
    if dl is not None:
        must_start_by = int(dl) - int(it.get("est_dur_s") or 0) - DEADLINE_SLACK_S
        if now >= must_start_by:
            return True, "deadline-forced"
    if MAX_DEFER_S > 0 and now - int(it.get("enqueued_ts") or now) >= MAX_DEFER_S:
        return True, "max-defer"
    return False, "await-valley"


def admit(now=None):
    """Decide which queued items to run this tick.

    Returns ``[{deploy_id, group, start_ts, reason}]``.  EDF ordering (deadline
    ascending, then larger VRAM first).  Commits when a card fits with margin
    *and* the valley clock allows; otherwise leaves the item ``deferred``.
    Never raises.
    """
    now = int(now if now is not None else time.time())
    out = []
    try:
        import forecast
    except Exception:
        forecast = None
    with _locked():
        d = _load()
        pend = [it for it in d["items"].values()
                if it.get("state") in ("queued", "deferred") and it.get("kind") == "train"]
        if not pend:
            # Nothing to decide → do not touch the file.  gpu_loop calls this
            # every 5s; rewriting an empty queue would churn ~17k files/day.
            return out
        favail = _forecast_ok(now)
        if not favail:
            _bump(d, "forecast_fallback")
        conf = _confidence(now) if favail else "low"
        pend.sort(key=lambda it: (it.get("deadline_ts") is None,
                                  it.get("deadline_ts") or 0,
                                  -(it.get("vram_mb") or 0)))
        # R_t: capacity this round has already committed.  ``free_mib`` is read
        # from the live GPU frame, which does *not* yet reflect commits made
        # microseconds ago (their state stays until gpu_loop places them), so a
        # per-round ledger is what stops two items claiming the same free MiB.
        reserved = {}
        dirty = False
        for it in pend:
            did = it.get("deploy_id")
            group = it.get("group")
            need = _need_mib(it, forecast)
            free = forecast.free_mib(group, now) if forecast else None
            margin = _margin_mib(need, conf)
            need_margin = need + margin
            held = int(reserved.get(group, 0))
            room = None if free is None else int(free) - held
            fits = (room is None) or (room >= need_margin)
            decision = {"ts": now, "action": None, "bin_start": now,
                        "margin": margin, "free_mib": free, "reserved_mib": held,
                        "free_eff_mib": room, "need_mib": need, "reason": ""}
            dl = it.get("deadline_ts")
            missed_hard = (dl is not None and now > int(dl)
                           and it.get("deadline_kind") == "hard"
                           and DEADLINE_MISS_POLICY != "run_anyway")
            if missed_hard:
                decision["action"] = "missed"
                decision["reason"] = f"hard-deadline-passed ({DEADLINE_MISS_POLICY})"
                it["state"] = "missed"
                _push_history(d, it, "missed")
                del d["items"][did]     # inline; re-entrant _finish would self-deadlock
                _bump(d, "missed")
                dirty = True
                continue
            allowed, why = _valley_ok(it, now, favail)
            if it.get("earliest_start") and now < int(it["earliest_start"]):
                decision["action"] = "defer"
                decision["reason"] = "not-before-earliest"
            elif not fits:
                decision["action"] = "defer"
                decision["reason"] = (f"no-room free_eff={room} need={need_margin} "
                                      f"(free={free} reserved={held})")
            elif not allowed:
                decision["action"] = "defer"
                decision["reason"] = why
            else:
                # commit intent only: state stays until gpu_loop places it and
                # calls mark_running (a failed place just re-admits next tick).
                decision["action"] = "commit"
                decision["reason"] = why
                it["attempts"] = int(it.get("attempts") or 0) + 1
                reserved[group] = held + need_margin
                if why == "max-defer":
                    _bump(d, "max_defer_admit")
                out.append({"deploy_id": did, "group": group,
                            "start_ts": now, "reason": why})
            prev = it.get("last_decision") or {}
            prev_state = it.get("state")
            it["last_decision"] = decision
            if decision["action"] == "defer":
                it["state"] = "deferred"
            if (it.get("state") != prev_state
                    or not (prev.get("action") == decision["action"]
                            and prev.get("reason") == decision["reason"]
                            and prev.get("free_eff_mib") == decision["free_eff_mib"])):
                dirty = True
        if out:
            _bump(d, "admitted", len(out))
        else:
            _bump(d, "admit_noop")
        # A blocked-but-unchanged queue (steady ``await-valley``) no longer
        # rewrites the file every 5s; the counters flush at least every
        # COUNTER_FLUSH_S so the health metrics stay fresh.
        if dirty or time.time() - int(d.get("generated_ts") or 0) >= COUNTER_FLUSH_S:
            _save(d)
    return out


# ── restart reconciliation ─────────────────────────────────────────────────
def reconcile(now=None):
    """Close items whose program is no longer placed (``running`` but gone from
    ``gpu_alloc``) — e.g. after a host reboot.  Returns the ids finished."""
    now = int(now if now is not None else time.time())
    done = []
    try:
        import scheduler
        alloc = scheduler.all_deploys()
    except Exception:
        return done
    with _locked():
        d = _load()
        for did, it in list(d["items"].items()):
            if it.get("state") == "running" and did not in alloc:
                it["state"] = "done"
                it["last_decision"] = {"ts": now, "action": "reconcile",
                                       "reason": "not-in-alloc"}
                _push_history(d, it, "reconcile")
                del d["items"][did]
                _bump(d, "reconciled")
                done.append(did)
        if done:
            _save(d)
    return done


if __name__ == "__main__":
    import json as _json
    print(_json.dumps(snapshot(), ensure_ascii=False, indent=2))
