"""Shared rotating log writer for yatterra background daemons.

Append a line to `path`, rotating when the file exceeds `max_bytes`.
Rotation keeps `backups` old copies (path.1 .. path.<backups>), logrotate
style: drop the oldest, shift the rest down, move current to .1.

Never raises — all errors are silently ignored so a logging failure can
never kill the daemon loop. Only imports `os`, so it is safe to import
from standalone daemons (pressure_writer) that avoid yatterra core.
"""
import os

DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # 50 MB
DEFAULT_BACKUPS = 3


def _rotate(path, max_bytes, backups):
    if not os.path.exists(path) or os.path.getsize(path) < max_bytes:
        return
    try:
        oldest = f"{path}.{backups}"
        if os.path.exists(oldest):
            os.remove(oldest)
        for i in range(backups - 1, 0, -1):
            src = f"{path}.{i}"
            dst = f"{path}.{i + 1}"
            if os.path.exists(src):
                os.rename(src, dst)
        os.rename(path, f"{path}.1")
    except Exception:
        pass


def write(path, line, max_bytes=DEFAULT_MAX_BYTES, backups=DEFAULT_BACKUPS):
    """Append `line` to `path` with size-based rotation. Never raises."""
    try:
        _rotate(path, max_bytes, backups)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
