#!/usr/bin/env python3
"""Persistent agent runs: decouple the ReAct generator from the HTTP request.

A run executes in a background thread; events are buffered and replayed to any
SSE subscriber with resumable ids (EventSource auto-reconnects with
Last-Event-ID, so a dropped connection resumes without loss or duplication).
Conversation history is persisted to disk so page reloads restore prior turns.
"""
import json, os, threading, time, uuid
import agent

import siteconf

HISTORY_FILE = siteconf.path("agent_history.json")
_HISTORY_LOCK = threading.Lock()
MAX_HISTORY_TURNS = 80  # user+assistant pairs kept per conversation

SESSIONS_FILE = siteconf.path("agent_sessions.json")
_SESSIONS_LOCK = threading.Lock()
MAX_SESSION_TURNS = 80  # user+assistant pairs kept per session


class Run:
    def __init__(self, run_id, mode, name, message, username=None):
        self.id = run_id
        self.mode = mode
        self.name = name
        self.message = message
        self.username = username or ""
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


RUNS = {}
_LOCK = threading.Lock()
MAX_RUNS = 30


def _evict():
    while len(RUNS) > MAX_RUNS:
        victim = None
        for k, r in RUNS.items():
            if r.done:
                victim = k
                break
        if victim is None:
            # all active — evict the oldest, but signal it to stop first so
            # its thread winds down instead of orphaning and holding LLM slots.
            victim = next(iter(RUNS))
            agent.stop(victim)
        RUNS.pop(victim, None)


def start(mode, name, message, history, run_id, session_id=None, user=None,
          username=None):
    run = Run(run_id, mode, name, message, username=username)
    with _LOCK:
        RUNS[run_id] = run
        _evict()

    def worker():
        assistant_text = ""
        got_done = False
        try:
            for ev in agent.run_agent(mode, name, message, history, run_id, user=user):
                run.append(ev)
                t = ev.get("type")
                if t == "text":
                    assistant_text += ev.get("data", "")
                elif t == "done":
                    assistant_text = ev.get("data", "") or assistant_text
                    got_done = True
                    break
                elif t == "error":
                    break
        except Exception as e:
            run.append({"type": "error", "data": f"内部错误: {e!r}"})
        finally:
            run.finish()
            agent._RUNS.pop(run_id, None)
            final = assistant_text if got_done else assistant_text.strip()
            if session_id:
                save_session_turn(session_id, mode, message, final)
            else:
                save_turn(mode, name, message, final, username=username)

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


# --- history persistence ---
def _load():
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data):
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, HISTORY_FILE)
    try:
        os.chmod(HISTORY_FILE, 0o600)
    except OSError:
        pass


def _key(mode, name, username=None):
    return f"{username or ''}:{mode}:{name or ''}"


def load_history(mode, name, username=None):
    with _HISTORY_LOCK:
        return _load().get(_key(mode, name, username), [])


def save_turn(mode, name, user_msg, assistant_msg, username=None):
    if not user_msg:
        return
    with _HISTORY_LOCK:
        data = _load()
        k = _key(mode, name, username)
        turns = data.get(k, [])
        turns.append({"role": "user", "content": user_msg})
        if assistant_msg and assistant_msg.strip():
            turns.append({"role": "assistant", "content": assistant_msg})
        cap = MAX_HISTORY_TURNS * 2
        if len(turns) > cap:
            turns = turns[-cap:]
        data[k] = turns
        _save(data)


def clear_history(mode, name, username=None):
    with _HISTORY_LOCK:
        data = _load()
        data.pop(_key(mode, name, username), None)
        _save(data)


# --- session persistence (multi-conversation per agent) ---
def _load_sessions():
    try:
        with open(SESSIONS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_sessions(data):
    tmp = SESSIONS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SESSIONS_FILE)
    try:
        os.chmod(SESSIONS_FILE, 0o600)
    except OSError:
        pass


def _new_title(msg):
    msg = (msg or "").strip().replace("\n", " ")
    return msg[:30] + ("…" if len(msg) > 30 else "") or "新对话"


def list_sessions(mode, username=None):
    """Return sessions for an agent+user, newest first.
    Each: id,title,updated,created,preview,n."""
    with _SESSIONS_LOCK:
        data = _load_sessions()
    out = []
    for sid, s in data.items():
        if s.get("mode") != mode:
            continue
        # filter by username; legacy sessions (username="") only visible to super
        s_user = s.get("username", "")
        if username is not None and s_user != username:
            continue
        turns = s.get("turns", [])
        preview = ""
        for t in turns:
            if t.get("role") == "user":
                preview = (t.get("content") or "").replace("\n", " ")[:40]
                break
        out.append({"id": sid, "title": s.get("title", "新对话"),
                    "updated": s.get("updated", 0), "created": s.get("created", 0),
                    "preview": preview, "n": len(turns)})
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


def create_session(mode, username=None, title=None):
    sid = uuid.uuid4().hex[:12]
    now = time.time()
    with _SESSIONS_LOCK:
        data = _load_sessions()
        data[sid] = {"mode": mode, "username": username or "",
                     "title": title or "新对话",
                     "created": now, "updated": now, "turns": []}
        _save_sessions(data)
    return sid


def get_session(sid, username=None):
    with _SESSIONS_LOCK:
        s = _load_sessions().get(sid)
    if not s:
        return None
    if username is not None and s.get("username", "") != username:
        return None
    return s


def load_session_history(sid, username=None):
    s = get_session(sid, username)
    return s.get("turns", []) if s else []


def save_session_turn(sid, mode, user_msg, assistant_msg):
    if not user_msg:
        return
    with _SESSIONS_LOCK:
        data = _load_sessions()
        s = data.get(sid)
        if not s:
            s = {"mode": mode, "username": "", "title": _new_title(user_msg),
                 "created": time.time(), "updated": time.time(), "turns": []}
            data[sid] = s
        turns = s.get("turns", [])
        turns.append({"role": "user", "content": user_msg})
        if assistant_msg and assistant_msg.strip():
            turns.append({"role": "assistant", "content": assistant_msg})
        cap = MAX_SESSION_TURNS * 2
        if len(turns) > cap:
            turns = turns[-cap:]
        s["turns"] = turns
        if not s.get("title") or s["title"] == "新对话":
            s["title"] = _new_title(user_msg)
        s["updated"] = time.time()
        data[sid] = s
        _save_sessions(data)


def delete_session(sid, username=None):
    with _SESSIONS_LOCK:
        data = _load_sessions()
        s = data.get(sid)
        if not s:
            return
        if username is not None and s.get("username", "") != username:
            return
        data.pop(sid, None)
        _save_sessions(data)


def rename_session(sid, title, username=None):
    with _SESSIONS_LOCK:
        data = _load_sessions()
        s = data.get(sid)
        if not s:
            return
        if username is not None and s.get("username", "") != username:
            return
        s["title"] = (title or "").strip()[:60] or s.get("title", "新对话")
        s["updated"] = time.time()
        _save_sessions(data)
