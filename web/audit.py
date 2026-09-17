"""Audit logging module.

Records JSON-line audit entries to /opt/yatterra/audit.log with
automatic rotation when the file exceeds 5 MB. All I/O is wrapped so that
no exception ever escapes; failures are silently swallowed on write and
yield an empty list on read.
"""

import json
import os

import siteconf

AUDIT_FILE = siteconf.path("audit.log")
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB rotation threshold


def _rotate_if_needed(path):
    """Rename path to path + '.1' when it exceeds the size limit.

    Any error is silently ignored.
    """
    try:
        if os.path.exists(path) and os.path.getsize(path) >= _MAX_BYTES:
            rotated = path + ".1"
            try:
                if os.path.exists(rotated):
                    os.remove(rotated)
            except Exception:
                pass
            os.rename(path, rotated)
    except Exception:
        pass


def resolve_operator():
    """Return the username behind the current request, or "system".

    Priority: g.api_user (Bearer token) > session (browser) > "system".
    Never raises.
    """
    try:
        from flask import g as flask_g, session as flask_session
        api_user = (getattr(flask_g, "api_user", None)
                    or getattr(flask_g, "_api_user_cache", None))
        if api_user and isinstance(api_user, dict):
            return api_user.get("username") or "system"
        return flask_session.get("user") or "system"
    except Exception:
        return "system"


def record(action, detail="", actor=None, module=None):
    """Append one audit entry as a JSON line.

    {"ts": <utc iso>, "action": action, "detail": detail, "actor": actor}

    Two ways to attribute an entry:

    * ``actor=<username>`` — the actor IS the operator (login, user CRUD, …).
    * ``module=<name>`` — the entry describes something a *subsystem* did
      (proxy_map, minio_svc, db_svc, deploys, …). ``actor`` becomes the module
      name and the resolved operator is appended to ``detail`` as
      ``by=<user>``, so the audit trail shows both who triggered it and which
      subsystem acted. Use this for anything a background job or a shared
      helper performs on the user's behalf.

    With neither, the actor is auto-resolved from the Flask context and
    falls back to "system".

    Creates the file (mode 644) if missing. Rotates to .1 past 5 MB.
    Never raises; all I/O errors are silently caught.
    """
    try:
        from datetime import datetime

        if module:
            operator = resolve_operator()
            actor = module
            detail = f"{detail} by={operator}" if detail else f"by={operator}"
        elif actor is None:
            actor = resolve_operator()

        entry = {
            "ts": datetime.utcnow().isoformat(),
            "action": action,
            "detail": detail,
            "actor": actor,
        }
        line = json.dumps(entry, ensure_ascii=False)

        _rotate_if_needed(AUDIT_FILE)

        # Create with mode 644 if it does not exist.
        if not os.path.exists(AUDIT_FILE):
            fd = os.open(
                AUDIT_FILE,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o644,
            )
            os.close(fd)

        with open(AUDIT_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def audit_entries(limit=100):
    """Return up to `limit` most recent audit entries, newest first.

    Reads the tail of the log, parses each JSON line, and returns the list
    in reverse chronological order. On any failure returns [].
    """
    try:
        if not os.path.exists(AUDIT_FILE):
            return []
        results = []
        with open(AUDIT_FILE, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
        for raw in reversed(lines):
            raw = raw.strip()
            if not raw:
                continue
            try:
                results.append(json.loads(raw))
            except Exception:
                continue
            if len(results) >= limit:
                break
        return results
    except Exception:
        return []
