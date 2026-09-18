"""Safe, user-scoped browser assistant runs.

This module deliberately does not import or call the privileged host-agent tool
runtime. The model may propose semantic browser actions; the browser remains the
only executor and must apply its own confirmation policy.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
import uuid
from typing import Any, Iterator

import llm
import siteconf

STATE_FILE = siteconf.path("browser_assistant_sessions.json")
MAX_TURNS = 80
MAX_CONTEXT = 24_000
MAX_RUNS = 64

_LOCK = threading.RLock()
_RUNS: dict[str, "Run"] = {}

_ALLOWED_ACTIONS = {"navigate", "click", "fill", "inspect"}
_SENSITIVE = re.compile(r"password|passphrase|secret|api[_ -]?key|token|authorization|cookie|credential", re.I)
_BLOCKED = re.compile(r"delete|remove|destroy|submit|upload|deploy|permission|role|credential|password|secret|token|api[_ -]?key|authorize|grant|revoke|reset|format|shutdown", re.I)


def _load() -> dict[str, Any]:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            value = json.load(f)
            return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(value: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, STATE_FILE)
    try:
        os.chmod(STATE_FILE, 0o600)
    except OSError:
        pass


def _new_session(username: str) -> str:
    sid = secrets.token_urlsafe(18)
    now = time.time()
    with _LOCK:
        data = _load()
        data[sid] = {"username": username, "created": now, "updated": now,
                     "title": "New conversation", "turns": []}
        _save(data)
    return sid


def get_session(sid: str, username: str) -> dict[str, Any] | None:
    with _LOCK:
        s = _load().get(sid)
    return s if isinstance(s, dict) and secrets.compare_digest(str(s.get("username", "")), username) else None


def list_sessions(username: str) -> list[dict[str, Any]]:
    with _LOCK:
        data = _load()
    result = []
    for sid, s in data.items():
        if not isinstance(s, dict) or s.get("username") != username:
            continue
        turns = s.get("turns") or []
        result.append({"id": sid, "title": s.get("title", "New conversation"),
                       "created": s.get("created", 0), "updated": s.get("updated", 0),
                       "n": len(turns), "preview": next((str(t.get("content", ""))[:80]
                           for t in turns if t.get("role") == "user"), "")})
    return sorted(result, key=lambda x: x["updated"], reverse=True)


def delete_session(sid: str, username: str) -> bool:
    with _LOCK:
        data = _load()
        if sid not in data or data[sid].get("username") != username:
            return False
        del data[sid]
        _save(data)
    return True


def _safe_context(context: Any) -> str:
    if not isinstance(context, str): return ""
    try: raw = json.loads(context)
    except (TypeError, ValueError): return ""
    if not isinstance(raw, list): return ""
    safe=[]
    for item in raw[:100]:
        if not isinstance(item, dict): continue
        row={k:item[k] for k in ("id","kind","label","route") if isinstance(item.get(k), str)}
        if row.get("id") and row.get("label") and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", row["id"]) and not _SENSITIVE.search(row["id"]+" "+row["label"]) and (row["id"].startswith("pod-tab-") or not _BLOCKED.search(row["id"]+" "+row["label"])): safe.append(row)
    return json.dumps(safe, ensure_ascii=False, separators=(",", ":"))[:MAX_CONTEXT]


def _parse_response(text: str) -> dict[str, Any]:
    """Parse model JSON without allowing arbitrary selectors/URLs/scripts."""
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.I | re.S).strip()
    try:
        obj = json.loads(raw)
    except (TypeError, ValueError):
        return {"message": text, "actions": []}
    if not isinstance(obj, dict):
        return {"message": text, "actions": []}
    actions = []
    for item in obj.get("actions", []) if isinstance(obj.get("actions"), list) else []:
        if not isinstance(item, dict) or item.get("type") not in _ALLOWED_ACTIONS:
            continue
        target = item.get("target_id")
        if not isinstance(target, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", target):
            continue
        action = {"id": str(item.get("id") or uuid.uuid4().hex),
                  "type": item["type"], "target_id": target,
                  "requires_confirmation": bool(item.get("requires_confirmation", item["type"] == "fill"))}
        if item["type"] == "fill":
            # Never accept or echo secret-like field ids/values.
            if _SENSITIVE.search(target) or (_BLOCKED.search(target) and not (target.startswith("pod-tab-") and item["type"] in {"click", "inspect"})):
                continue
            value = item.get("value", "")
            if not isinstance(value, str) or len(value) > 2000 or _SENSITIVE.search(value):
                continue
            action["value"] = value
        if item["type"] == "navigate":
            route = item.get("route")
            if not isinstance(route, str) or not route.startswith("/") or route.startswith("//") or "\\" in route:
                continue
            action["route"] = route[:300]
        actions.append(action)
    return {"message": str(obj.get("message", ""))[:8000], "actions": actions}


class Run:
    def __init__(self, run_id: str, username: str):
        self.id, self.username = run_id, username
        self.events: list[dict[str, Any]] = []
        self.cond = threading.Condition()
        self.done = False
        self.stop_event = threading.Event()

    def add(self, event: dict[str, Any]) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.cond.notify_all()


def start(username: str, session_id: str, message: str, page: str = "", context: str = "", receipt: Any = None) -> tuple[str, str]:
    if not isinstance(username, str) or not username or not isinstance(message, str) or not message.strip() or len(message) > 8000:
        raise ValueError("message is required and must be <= 8000 characters")
    sid = session_id or _new_session(username)
    session = get_session(sid, username)
    if not session:
        raise LookupError("session not found")
    run_id = secrets.token_hex(12)
    run = Run(run_id, username)
    with _LOCK:
        _RUNS[run_id] = run
        while len(_RUNS) > MAX_RUNS:
            old = next(iter(_RUNS))
            if old != run_id and _RUNS[old].done:
                _RUNS.pop(old, None)
            else:
                break
    turns = list(session.get("turns") or [])[-MAX_TURNS:]
    state = {"page": str(page)[:120], "context": _safe_context(context), "receipt": receipt if isinstance(receipt, dict) else None}
    user_content = message.strip() + "\n\n[Browser state]\n" + json.dumps(state, ensure_ascii=False)
    turns.append({"role": "user", "content": user_content})

    def worker() -> None:
        try:
            system = ("You are YatTerra's universal browser assistant. Answer in JSON only: "
                      '{"message":"...","actions":[...]} . Actions use only registered target_id values. '
                      "Never invent selectors, JavaScript, external URLs, credentials, or hidden controls. "
                      "navigate uses an internal route beginning with /; click/inspect use target_id; "
                      "fill is always a proposal and must never target sensitive fields. Mutations must set "
                      "requires_confirmation true. The browser, not you, executes actions.")
            pieces = []
            for kind, piece in llm.stream_chat(turns, system=system, max_tokens=4096,
                                                caller="browser_assistant", user=username):
                if run.stop_event.is_set():
                    run.add({"type": "done", "data": "Stopped", "cancelled": True})
                    return
                if kind == "content":
                    pieces.append(piece)
                    run.add({"type": "content", "data": piece})
            parsed = _parse_response("".join(pieces))
            run.add({"type": "proposal", "data": parsed})
            run.add({"type": "done", "data": parsed.get("message", "")})
            with _LOCK:
                data = _load(); s = data.get(sid)
                if s and s.get("username") == username:
                    s.setdefault("turns", []).extend([{"role": "user", "content": message.strip()},
                                                        {"role": "assistant", "content": parsed.get("message", ""), "actions": parsed.get("actions", [])}])
                    s["turns"] = s["turns"][-MAX_TURNS:]; s["updated"] = time.time()
                    if s.get("title") == "New conversation": s["title"] = message.strip()[:60]
                    _save(data)
        except Exception as exc:
            run.add({"type": "error", "data": "Assistant unavailable"})
        finally:
            run.finish()
    threading.Thread(target=worker, daemon=True).start()
    return sid, run_id


def get_run(run_id: str, username: str) -> Run | None:
    with _LOCK:
        run = _RUNS.get(run_id)
    return run if run and run.username == username else None


def stop(run_id: str, username: str) -> bool:
    run = get_run(run_id, username)
    if not run: return False
    run.stop_event.set(); return True


def stream(run_id: str, username: str, after: int = 0) -> Iterator[tuple[int, dict[str, Any]] | None]:
    run = get_run(run_id, username)
    if not run: return
    i = max(0, after)
    while True:
        with run.cond:
            if len(run.events) > i:
                batch = [(j, run.events[j]) for j in range(i, len(run.events))]; i = len(run.events)
            elif run.done: return
            else: run.cond.wait(timeout=10); batch = []
        if batch:
            yield from batch
        else: yield None
