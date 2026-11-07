#!/usr/bin/env python3
"""Time-series feature daemon: python3 feat_loop.py [--once] [--interval N].

Consolidates the two signals the reactive control stack currently keeps no
history of, into the ``features.db`` store (see ``feature_store``):

- **per-group demand/usage** — read *back* from ``usage_samples`` (the metering
  daemon already integrates it) and resampled into rate features
  (``cpu_cores`` = core-seconds/``dt`` etc.).  This DB never re-derives usage;
  it only re-shapes what ``usage_meter`` recorded.
- **host pressure** — the instantaneous ``pressure.json`` picture, folded into
  per-hour avg/max per dimension plus ``level_seconds`` (how long each hour
  spent at each hysteretic level).

Together these give the forecast/MPC layer (``forecast.py``, P1-b) the time
axis it lacks — the substrate for valley-shifting AI-ops work and peak-time
shedding.

Single writer: the DB is flock-guarded; a second instance exits non-zero.
Never crashes on a bad tick; SIGTERM/INT stop cleanly.  Read-only access to the
meter DB, so it can never disturb the metering daemon's single-writer invariant.
"""
import argparse
import fcntl
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import logutil  # noqa: E402
import siteconf  # noqa: E402
from feature_store import FeatureStore  # noqa: E402
from usage_store import UsageStore  # noqa: E402

LOG = siteconf.path("feat_loop.log")
PRESSURE_FILE = os.environ.get(
    "YATTERRA_FEATURE_PRESSURE_FILE",
    os.path.join(siteconf.PRESSURE_DIR, "pressure.json"))

# Wall time of the previous tick, for dt.  Module global so tests can reset it.
_LAST_TS = None

INTERVAL = 30  # default, overwritten in main()

# feat_pressure_samples / _hourly columns ← pressure.json ``stats`` (4-tuple:
# avg source key, avg column, peak source key, peak column).  ``gpu`` peaks at
# ``gpu_max`` and ``gpu_mem`` at ``gpu_mem_max`` — the keys the hysteresis level
# dims use — rather than the plain dim's own peak.
_PRESSURE_MAP = (
    ("cpu", "cpu_avg", "cpu", "cpu_max"),
    ("gpu", "gpu_avg", "gpu_max", "gpu_max"),
    ("gpu_mem", "gpu_mem_avg", "gpu_mem_max", "gpu_mem_max"),
    ("mem", "mem_avg", "mem", "mem_max"),
    (None, None, "psi_max", "psi_max"),
    (None, None, "psi_cpu", "psi_cpu_max"),
    (None, None, "psi_mem", "psi_mem_max"),
    (None, None, "psi_io", "psi_io_max"),
    ("bw", "bw_avg", "bw", "bw_max"),
    (None, None, "disk_max", "disk_max"),
)


def log(msg):
    logutil.write(LOG, f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _dt(now):
    prev = _LAST_TS
    if not prev:
        return None
    d = now - prev
    if not (0 < d <= 4 * max(1, INTERVAL)):
        d = float(INTERVAL)
    return d


def sample_platform(now, dt=None):
    """Host-pressure row from ``pressure.json`` for this tick, or None.

    Returns ``None`` (never raises) when the file is missing, unreadable or
    malformed — a broken pressure file must not kill the loop.  ``stats.<dim>``
    supplies ``avg``/``peak``; ``level`` is stored verbatim as JSON so the
    rollup can accumulate ``level_seconds``.
    """
    try:
        with open(PRESSURE_FILE) as f:
            p = json.load(f)
    except Exception:
        return None
    if not isinstance(p, dict):
        return None
    stats = p.get("stats") or {}

    def pk(key):
        s = (stats.get(key) or {}) if key else {}
        return _num(s.get("peak"))

    def av(key):
        s = (stats.get(key) or {}) if key else {}
        return _num(s.get("avg"))

    row = {"ts": now, "dt": float(dt or 0)}
    for avg_key, avg_col, peak_key, peak_col in _PRESSURE_MAP:
        if avg_col:
            row[avg_col] = av(avg_key)
        if peak_col:
            row[peak_col] = pk(peak_key)
    try:
        level = p.get("level") or {}
    except Exception:
        level = {}
    row["level_json"] = json.dumps(level if isinstance(level, dict) else {},
                                   ensure_ascii=False)
    return row


def sample_groups(since_ts, now):
    """Per-group rate rows from ``usage_samples`` over ``(since_ts, now]``.

    Read-only on the meter DB.  ``cpu_cores`` = core-seconds/``dt`` (the demand
    rate); the raw integrals are recomputed by the rollup from these rates, so
    nothing is double-counted.  Rows with a non-positive ``dt`` are skipped.
    """
    if since_ts is None:
        since_ts = now - max(INTERVAL, 1)
    # bound the window so a long stall can't ingest an unbounded backlog
    since_ts = max(since_ts, now - 4 * max(INTERVAL, 1))
    try:
        rows = UsageStore()._read(
            """SELECT group_name, ts, dt, cpu_core_seconds, cpu_req_core_seconds,
                      mem_gib, gpu_util_sum, gpu_mem_mib
               FROM usage_samples WHERE ts > ? AND ts <= ? ORDER BY ts""",
            (since_ts, now))
    except Exception:
        return []
    out = []
    for r in rows:
        d = float(r.get("dt") or 0)
        if d <= 0:
            continue
        out.append({
            "group_name": r.get("group_name"),
            "ts": r.get("ts"),
            "dt": d,
            "cpu_cores": (r.get("cpu_core_seconds") or 0) / d,
            "cpu_req_cores": (r.get("cpu_req_core_seconds") or 0) / d,
            "mem_gib": r.get("mem_gib") or 0,
            "gpu_util": r.get("gpu_util_sum") or 0,
            "gpu_mem_mib": r.get("gpu_mem_mib") or 0,
        })
    return out


def take_tick(now):
    """Sample one tick and return (group_rows, platform_row, prev_ts)."""
    global _LAST_TS
    prev_ts = _LAST_TS
    groups = sample_groups(prev_ts, now)
    platform = sample_platform(now, _dt(now))
    _LAST_TS = now
    return groups, platform, prev_ts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="run one tick and exit")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()
    if args.interval < 5:
        parser.error("interval must be at least 5 seconds")
    global INTERVAL
    INTERVAL = args.interval

    os.umask(0o027)
    store = FeatureStore()
    store.initialize()
    Path(store.path).parent.mkdir(parents=True, exist_ok=True)
    with open(store.path + ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Another feature loop owns this database\n")

        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())

        log(f"feat_loop start interval={args.interval}s db={store.path}")
        while not stop.is_set():
            started = time.monotonic()
            try:
                now = time.time()
                groups, platform, prev_ts = take_tick(now)
                store.write_tick(groups, platform, now, prev_ts)
                log(f"tick ok groups={len(groups)} pressure={bool(platform)} "
                    f"in {time.monotonic() - started:.1f}s")
            except Exception as exc:
                log(f"tick failed: {type(exc).__name__}: {exc}")
                if args.once:
                    raise
            if args.once:
                break
            stop.wait(max(1, args.interval - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
