#!/usr/bin/env python3
"""Rename jobs: run a pod rename in the background and stream its progress.

A rename is slow — it lazily unmounts the loop data image, moves the directory,
rebuilds the Deployment and rewrites frpc/nginx. Blocking the HTTP request for
all of that gives the user a spinner with no idea what is happening. Instead we
run it in a worker thread and buffer one event per step; any SSE subscriber
replays the buffer and then follows live (resumable via Last-Event-ID, same
shape as agent_runs.Run).
"""
import json
import threading
import time
import uuid

import groups
import nodes


class Job:
    def __init__(self, jid, old, new, node, username):
        self.id = jid
        self.old = old
        self.new = new
        self.node = node or nodes.DEFAULT_NODE
        self.username = username or ""
        self.t0 = time.time()
        self.events = []
        self.cond = threading.Condition()
        self.done = False
        self.ok = None            # None=running, True=renamed, False=failed
        self.error = ""
        self.result = None

    def append(self, ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def finish(self, ok, error="", result=None):
        with self.cond:
            self.ok = ok
            self.error = error
            self.result = result
            self.done = True
            self.cond.notify_all()


JOBS = {}
_LOCK = threading.Lock()
MAX_JOBS = 50


def _evict():
    """Drop the oldest finished job once we exceed the cap."""
    with _LOCK:
        while len(JOBS) > MAX_JOBS:
            victim = next((k for k, j in JOBS.items() if j.done), None)
            if victim is None:
                break
            JOBS.pop(victim, None)


def precheck(old, new):
    """Fast synchronous validation so an obvious mistake 400s immediately.

    Returns the normalized name; raises ValueError on a bad request.
    """
    new = groups.normalize_name(new)
    state = groups.load_state()
    g = state["groups"].get(old)
    if not g:
        raise ValueError(f"组 {old} 不存在")
    if g.get("type") in ("windows", "android"):
        raise ValueError("VM 组(android/windows)不支持改名")
    if new == old:
        raise ValueError("新名字与原名相同")
    if new in state["groups"]:
        raise ValueError(f"组 {new} 已存在")
    return new


def start(old, new, username=None):
    """Validate, then run the rename in a background thread. Returns the Job."""
    new = precheck(old, new)
    g = groups.load_state()["groups"].get(old) or {}
    node = nodes.node_for(g) or nodes.DEFAULT_NODE
    jid = uuid.uuid4().hex[:12]
    job = Job(jid, old, new, node, username)
    with _LOCK:
        JOBS[jid] = job
    _evict()

    job.append({"type": "start", "old": old, "new": new, "node": node})

    def worker():
        try:
            g = groups.rename_group(
                old, new, progress=lambda ev: job.append(dict(ev, type="step")))
            result = {"name": g["name"], "ssh_public": g.get("ssh_public"),
                      "web_public": g.get("web_public")}
            job.append(dict(result, type="result"))
            job.finish(True, result=result)
        except Exception as e:
            job.append({"type": "failed", "error": str(e)})
            job.finish(False, error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return job


def get(jid):
    with _LOCK:
        return JOBS.get(jid)


def snapshot(jid):
    job = get(jid)
    if not job:
        return None
    return {"id": job.id, "old": job.old, "new": job.new, "node": job.node,
            "done": job.done, "ok": job.ok, "error": job.error,
            "events": list(job.events)}


def stream_events(jid, after=0):
    """Yield (index, event) after `after`, or None on a keepalive tick.
    Stops once the job is done and its buffer has been drained."""
    job = get(jid)
    if not job:
        return
    i = after
    while True:
        with job.cond:
            n = len(job.events)
            if n > i:
                batch = [(i + k, job.events[i + k]) for k in range(n - i)]
                i = n
            else:
                batch = None
                if not job.done:
                    job.cond.wait(timeout=10)
                if job.done and len(job.events) <= i:
                    return
        if batch:
            for idx, ev in batch:
                yield idx, ev
        else:
            yield None


def sse(jid, after=0):
    """Yield ready-to-write SSE frames for the rename stream."""
    yield ": open\n\n"
    for item in stream_events(jid, after):
        if item is None:
            yield ": ping\n\n"
            continue
        idx, ev = item
        yield f"id: {idx}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
