#!/usr/bin/env python3
"""Published time-axis snapshot — the read side of the valley/peak clock.

``timeline.json`` is the single *published* artefact of the forecast layer
(P1-b): the current phase, the next valley/peak windows, and an optional
per-group override.  P1-c (defer_queue / scheduler) reads it here rather than
reaching into forecast internals.  Single writer = forecast; this module only
reads (and provides the atomic writer it uses).

Phase is ``peak`` | ``shoulder`` | ``valley``, defaulting to ``shoulder`` when
the file is missing or unreadable — a broken timeline must never change
scheduling behaviour.  ``now`` inside a published valley window reads as
``valley`` even if the coarse phase says otherwise.

Never raises.
"""
import json
import os
import time

import siteconf

TIMELINE_FILE = siteconf.path("timeline.json")
SCHEMA = 1
_VALID_PHASES = ("peak", "shoulder", "valley")


def read():
    """Parsed timeline dict, or ``{}`` if missing/unreadable/malformed."""
    try:
        with open(TIMELINE_FILE) as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def write(obj):
    """Atomically replace the timeline file.  Stamps ``schema``/``generated_ts``.

    Writes a sibling temp file then ``os.replace`` (same filesystem → atomic on
    POSIX).  Best-effort ``0640`` to match the other platform data files.
    Returns the object written.  Never raises.
    """
    if not isinstance(obj, dict):
        obj = {}
    obj = dict(obj)
    obj.setdefault("schema", SCHEMA)
    obj.setdefault("generated_ts", int(time.time()))
    tmp = TIMELINE_FILE + ".tmp"
    try:
        os.makedirs(os.path.dirname(TIMELINE_FILE), exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(obj, f, ensure_ascii=False)
        try:
            os.chmod(tmp, 0o640)
        except OSError:
            pass
        os.replace(tmp, TIMELINE_FILE)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return obj


def _window_contains(win, now):
    try:
        return float(win.get("start")) <= now < float(win.get("end"))
    except (TypeError, ValueError, AttributeError):
        return False


def phase(now=None):
    """Current phase (``peak``|``shoulder``|``valley``); ``shoulder`` default."""
    now = float(now if now is not None else time.time())
    t = read()
    p = t.get("phase")
    base = p if p in _VALID_PHASES else "shoulder"
    if base != "valley" and _window_contains(t.get("next_valley"), now):
        return "valley"
    return base


def is_valley(now=None):
    return phase(now) == "valley"


def next_valley(now=None):
    """Published next-valley window dict (or ``{}``)."""
    return read().get("next_valley") or {}


def next_peak(now=None):
    return read().get("next_peak") or {}


def group_phase(group, now=None):
    """Phase for a specific group (published override), else the platform phase."""
    now = float(now if now is not None else time.time())
    pg = (read().get("per_group") or {}).get(group) or {}
    p = pg.get("phase")
    if p in _VALID_PHASES:
        return p
    return phase(now)
