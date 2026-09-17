#!/usr/bin/env python3
"""Persistent harness runs: decouple the DAG executor from the HTTP request.

A harness run executes in a background thread; events are buffered and replayed
to any SSE subscriber with resumable ids (EventSource auto-reconnects with
Last-Event-ID, so a dropped connection resumes without loss or duplication).
"""
import threading

import agent

RUNS = {}
_LOCK = threading.Lock()
MAX_RUNS = 20


class Run:
    def __init__(self, run_id, hname):
        self.id = run_id
        self.hname = hname
        self.events = []
        self.cond = threading.Condition()
        self.done = False
        self.thread = None

    def append(self, ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def finish(self):
        with self.cond:
            self.done = True
            self.cond.notify_all()


def _evict():
    while len(RUNS) > MAX_RUNS:
        victim = None
        for k, r in RUNS.items():
            if r.done:
                victim = k
                break
        if victim is None:
            victim = next(iter(RUNS))
        RUNS.pop(victim, None)


def start(hname, run_id, user=None):
    run = Run(run_id, hname)
    with _LOCK:
        RUNS[run_id] = run
        _evict()

    def worker():
        try:
            for ev in agent.run_harness(hname, run_id, user=user):
                run.append(ev)
                if ev.get("type") in ("harness_done", "error"):
                    break
        except Exception as e:
            run.append({"type": "error", "data": f"内部错误: {e!r}"})
        finally:
            run.finish()
            agent._RUNS.pop(run_id, None)

    t = threading.Thread(target=worker, daemon=True)
    run.thread = t
    t.start()
    return run


def get(run_id):
    with _LOCK:
        return RUNS.get(run_id)


def stream_events(run_id, after=0):
    """Yield (index, event) for buffered+live events after `after`.
    Yields None for a keepalive tick when idle. Stops when the run is done."""
    run = get(run_id)
    if not run:
        return
    i = after
    while True:
        with run.cond:
            n = len(run.events)
            if n > i:
                batch = [(i + k, run.events[i + k]) for k in range(n - i)]
                i = n
            else:
                batch = None
                if not run.done:
                    run.cond.wait(timeout=10)
                if run.done and len(run.events) <= i:
                    return
        if batch:
            for idx, ev in batch:
                yield idx, ev
        else:
            yield None
