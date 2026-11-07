#!/usr/bin/env python3
"""Flexibility contract: who may be deferred, preempted, or must meet a deadline.

One normalised reader over two levels of existing key/value storage — a group's
``env`` map and (optionally) a dep's own fields/``env`` — so the scheduler,
``gpu_loop`` and ``priority_kill`` all ask the *same* question the same way,
instead of each re-deriving defaults from ``kind``.

Contract keys (env-style, uppercase): ``DEFER_OK``, ``PREEMPT_OK``, ``DEADLINE``
(``EST_DURATION_S`` is introduced by P1-c).  Precedence is **dep > group >
default**.

Defaults deliberately reproduce today's behaviour exactly (a strict no-op until
someone opts in):

- ``preempt_ok`` default = ``kind == "train"`` — matching
  ``deploys._scheduling_ctx``'s existing ``preemptable``.
- ``defer_ok`` default = ``False`` for *every* kind (v1 is opt-in; flipping
  train→True would silently change every unrunnable train into a new ``deferred``
  state).
- ``deadline`` default = ``None``.

``critical`` locks ``preempt_ok`` to ``False`` one-way — a dep env cannot raise
it back (safety side).

Never raises: a broken group store falls back to defaults.
"""
import datetime as _dt
import time

_TRUE = {"1", "true", "yes", "on", "y", "t"}
_FALSE = {"0", "false", "no", "off", "n", "f", ""}

_VALID_PHASES = ("peak", "shoulder", "valley")


def parse_bool(v):
    """Total truthiness parser. Unknown strings → False (conservative)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    if v is None:
        return False
    return str(v).strip().lower() in _TRUE


def _duration(s):
    """Parse ``+90s`` / ``+1h`` / ``+2m`` / ``+1d`` (possibly multiple terms)."""
    body = s[1:].strip().lower()
    if not body:
        return None
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    total = 0
    num = ""
    seen = False
    for ch in body:
        if ch.isdigit() or ch == ".":
            num += ch
            continue
        if ch in units and num:
            total += float(num) * units[ch]
            num = ""
            seen = True
        elif ch in (" ", "\t"):
            continue
        else:
            return None
    if num:  # bare trailing number → seconds
        total += float(num)
        seen = True
    return int(total) if seen else None


def parse_deadline(v, now=None):
    """Parse a deadline → epoch UTC int, or None.

    Accepts epoch (int/float/numeric str), a relative ``+Ns``/``+Nh``/``+Nm``/
    ``+Nd``, or ISO-8601 (naive treated as UTC).  Invalid → None (no deadline).
    """
    if v is None or v == "":
        return None
    now = int(now if now is not None else time.time())
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    if not s:
        return None
    if s.startswith("+"):
        d = _duration(s)
        return (now + d) if d is not None else None
    # numeric epoch string
    try:
        return int(float(s))
    except ValueError:
        pass
    # ISO-8601 (allow trailing Z)
    try:
        iso = s[:-1] + "+00:00" if s.endswith("Z") else s
        dt = _dt.datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def derive_defaults(kind, priority=None):
    """Default contract for a scheduling class (no env consulted)."""
    kind = (kind or "serve").lower()
    preempt = (kind == "train")
    if (priority or "").lower() == "critical":
        preempt = False
    return {"defer_ok": False, "preempt_ok": preempt, "deadline": None}


def _group_dict(group):
    """Accept a group name or a group dict; never raises."""
    if isinstance(group, dict):
        return group
    try:
        import groups
        st = groups.load_state() or {}
        return (st.get("groups") or {}).get(group) or {}
    except Exception:
        return {}


def _sources(group, dep):
    """Merged {UPPER_KEY: value} from group env then dep (dep wins)."""
    out = {}
    for k, v in (_group_dict(group).get("env") or {}).items():
        out[str(k).upper()] = v
    if isinstance(dep, dict):
        for k, v in (dep.get("env") or {}).items():
            out[str(k).upper()] = v
        # allow first-class dep fields as well as env-style keys
        for key, field in (("DEFER_OK", "defer_ok"),
                           ("PREEMPT_OK", "preempt_ok"),
                           ("DEADLINE", "deadline")):
            if dep.get(field) is not None:
                out[key] = dep.get(field)
    return out


def contract_for(group, dep=None, now=None):
    """Resolve the effective contract.  ``{defer_ok, preempt_ok, deadline}``."""
    now = int(now if now is not None else time.time())
    kind = ((dep or {}).get("kind") or "serve") if isinstance(dep, dict) else "serve"
    priority = (dep or {}).get("priority") if isinstance(dep, dict) else None
    priority = priority or _group_dict(group).get("priority")

    c = derive_defaults(kind, priority)
    env = _sources(group, dep)
    if "DEFER_OK" in env:
        c["defer_ok"] = parse_bool(env["DEFER_OK"])
    if "PREEMPT_OK" in env:
        c["preempt_ok"] = parse_bool(env["PREEMPT_OK"])
    if "DEADLINE" in env:
        c["deadline"] = parse_deadline(env["DEADLINE"], now)
    if (priority or "").lower() == "critical":
        c["preempt_ok"] = False  # one-way lock: cannot be raised by dep env
    return c


def preemptable(group, dep=None, now=None):
    return bool(contract_for(group, dep, now)["preempt_ok"])


def deferable(group, dep=None, now=None):
    return bool(contract_for(group, dep, now)["defer_ok"])


def deadline_ts(group, dep=None, now=None):
    return contract_for(group, dep, now)["deadline"]
