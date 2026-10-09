#!/usr/bin/env python3
"""Per-user conversation history for the page AI assistant (`/api/ai/page`).

Stored in MySQL (the same `yatterra` database managed by users.py) so a
conversation survives page navigation and browser reloads, and is isolated
per account.  The table is created lazily on first use (`CREATE TABLE IF
NOT EXISTS`), reusing users.py's connection pool — no second pool.

Granularity: one global list of conversations per user, shared across all
pages (like a chat app), NOT one per page/pod.  `page` is stored only as
provenance metadata.

Every read/write takes a `username` and filters on it; a session id alone
never grants access to another account's conversation.
"""
import threading
import uuid
from importlib import import_module

from middleware.error_handler import not_found

users = import_module("users")

MAX_SESSION_TURNS = 80   # user+assistant pairs kept per conversation

_INIT_LOCK = threading.Lock()
_INITED = False

_DDL_SESSIONS = """
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id         CHAR(32)     PRIMARY KEY,
        username   VARCHAR(64)  NOT NULL,
        title      VARCHAR(128) NOT NULL DEFAULT '新对话',
        page       VARCHAR(32)  NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_updated (username, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""

_DDL_MESSAGES = """
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id         BIGINT       AUTO_INCREMENT PRIMARY KEY,
        session_id CHAR(32)     NOT NULL,
        username   VARCHAR(64)  NOT NULL,
        role       VARCHAR(16)  NOT NULL,
        content    MEDIUMTEXT   NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_session (session_id, id),
        INDEX idx_user (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


def _ensure_init():
    """Create the tables once. Piggybacks on users.py's DB bootstrap."""
    global _INITED
    if _INITED:
        return
    users._ensure_init()
    with _INIT_LOCK:
        if _INITED:
            return
        with users._conn() as cn:
            with cn.cursor() as cur:
                cur.execute(_DDL_SESSIONS)
                cur.execute(_DDL_MESSAGES)
        _INITED = True


def _new_title(msg):
    msg = (msg or "").strip().replace("\n", " ")
    return msg[:30] + ("…" if len(msg) > 30 else "") or "新对话"


def _row_count(cur, sid, username):
    cur.execute("SELECT COUNT(*) AS n FROM ai_chat_messages "
                "WHERE session_id=%s AND username=%s", (sid, username))
    return cur.fetchone()["n"]


def list_sessions(username):
    """Conversations for `username`, newest first.

    Each: {id, title, updated, created, preview, n, page}.
    """
    if not username:
        return []
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT s.id, s.title, s.page, "
                "       UNIX_TIMESTAMP(s.created_at) AS created, "
                "       UNIX_TIMESTAMP(s.updated_at) AS updated, "
                "       (SELECT COUNT(*) FROM ai_chat_messages m "
                "        WHERE m.session_id=s.id) AS n "
                "FROM ai_chat_sessions s WHERE s.username=%s "
                "ORDER BY s.updated_at DESC, s.created_at DESC",
                (username,))
            rows = cur.fetchall() or []
            out = []
            for s in rows:
                cur.execute(
                    "SELECT content FROM ai_chat_messages "
                    "WHERE session_id=%s AND role='user' "
                    "ORDER BY id ASC LIMIT 1", (s["id"],))
                first = cur.fetchone()
                preview = ((first or {}).get("content") or "").replace("\n", " ")[:40]
                out.append({"id": s["id"], "title": s["title"] or "新对话",
                            "page": s.get("page"), "updated": s.get("updated") or 0,
                            "created": s.get("created") or 0,
                            "preview": preview, "n": s.get("n") or 0})
    return out


def create_session(username, page=None, title=None):
    sid = uuid.uuid4().hex
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "INSERT INTO ai_chat_sessions (id, username, title, page) "
                "VALUES (%s, %s, %s, %s)",
                (sid, username, title or "新对话", (page or None)))
    return sid


def get_session(sid, username):
    """Return {id,title,page,created,updated} or None (ownership enforced)."""
    if not sid or not username:
        return None
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT id, title, page, "
                "       UNIX_TIMESTAMP(created_at) AS created, "
                "       UNIX_TIMESTAMP(updated_at) AS updated "
                "FROM ai_chat_sessions WHERE id=%s AND username=%s",
                (sid, username))
            return cur.fetchone()


def load_messages(sid, username):
    """Conversation turns [{role, content, ts}] for the UI, oldest first."""
    if not sid or not username:
        return []
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute(
                "SELECT role, content, UNIX_TIMESTAMP(created_at) AS ts "
                "FROM ai_chat_messages WHERE session_id=%s AND username=%s "
                "ORDER BY id ASC", (sid, username))
            return [{"role": r["role"], "content": r["content"],
                     "ts": r.get("ts") or 0} for r in (cur.fetchall() or [])]


def load_history(sid, username, limit=MAX_SESSION_TURNS * 2):
    """LLM-shaped history [{role, content}] (oldest→newest, capped) or []."""
    msgs = load_messages(sid, username)
    shaped = [{"role": m["role"], "content": m["content"]}
              for m in msgs if m.get("content") and m["role"] in ("user", "assistant")]
    return shaped[-limit:]


def append_turn(sid, username, user_msg, assistant_msg):
    """Persist one exchange; auto-title on the first turn; cap stored turns."""
    if not sid or not username or not user_msg:
        return
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute("SELECT id, title FROM ai_chat_sessions "
                        "WHERE id=%s AND username=%s", (sid, username))
            sess = cur.fetchone()
            if not sess:
                return
            cur.execute(
                "INSERT INTO ai_chat_messages (session_id, username, role, content) "
                "VALUES (%s, %s, 'user', %s)", (sid, username, user_msg))
            if assistant_msg and assistant_msg.strip():
                cur.execute(
                    "INSERT INTO ai_chat_messages (session_id, username, role, content) "
                    "VALUES (%s, %s, 'assistant', %s)", (sid, username, assistant_msg))
            # Re-title when still the default placeholder.
            if not sess.get("title") or sess["title"] == "新对话":
                cur.execute("UPDATE ai_chat_sessions SET title=%s "
                            "WHERE id=%s AND username=%s",
                            (_new_title(user_msg), sid, username))
            cur.execute("UPDATE ai_chat_sessions SET updated_at=NOW() "
                        "WHERE id=%s AND username=%s", (sid, username))
            # Trim oldest rows beyond the cap.
            keep = MAX_SESSION_TURNS * 2
            n = _row_count(cur, sid, username)
            if n > keep:
                cur.execute(
                    "DELETE FROM ai_chat_messages WHERE session_id=%s AND username=%s "
                    "ORDER BY id ASC LIMIT %s", (sid, username, n - keep))


def delete_session(sid, username):
    if not sid or not username:
        return
    _ensure_init()
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute("DELETE FROM ai_chat_messages "
                        "WHERE session_id=%s AND username=%s", (sid, username))
            cur.execute("DELETE FROM ai_chat_sessions "
                        "WHERE id=%s AND username=%s", (sid, username))


def rename_session(sid, title, username):
    if not sid or not username:
        return
    _ensure_init()
    title = (title or "").strip()[:128]
    with users._conn() as cn:
        with cn.cursor() as cur:
            cur.execute("UPDATE ai_chat_sessions SET title=%s "
                        "WHERE id=%s AND username=%s",
                        (title or "新对话", sid, username))


def require_session(sid, username):
    """Abort with 404 when the session is missing or not owned by `username`."""
    s = get_session(sid, username)
    if not s:
        raise not_found("Session not found")
    return s
