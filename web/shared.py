#!/usr/bin/env python3
"""Shared directory: hostPath /mnt/sdb/shared mounted read-only into every
group pod at /shared (so pods see /shared/weights, /shared/datasets, ...).
Teacher manages contents via the platform UI. readOnly volumeMount keeps the
whole tree read-only inside the pod even with sudo."""
import os
import shutil
from datetime import datetime

import siteconf

ROOT = siteconf.SHARED_ROOT


def ensure():
    os.makedirs(ROOT, exist_ok=True)
    try:
        os.chmod(ROOT, 0o755)
    except OSError:
        pass


def _abs(rel):
    """Resolve rel under ROOT, reject traversal. Return absolute path."""
    ensure()
    rel = (rel or "").strip().lstrip("/")
    full = os.path.normpath(os.path.join(ROOT, rel))
    if full != ROOT and not full.startswith(ROOT + os.sep):
        raise ValueError("非法路径")
    return full


def _rel(path):
    """Path relative to ROOT ("" for ROOT)."""
    if path == ROOT:
        return ""
    return os.path.relpath(path, ROOT)


def list_dir(rel=""):
    """List one level under ROOT/rel. Returns (entries, current_rel)."""
    base = _abs(rel)
    if not os.path.isdir(base):
        raise ValueError("不是目录")
    out = []
    for name in sorted(os.listdir(base)):
        p = os.path.join(base, name)
        try:
            st = os.stat(p)
        except OSError:
            continue
        out.append({
            "name": name,
            "is_dir": os.path.isdir(p),
            "size": 0 if os.path.isdir(p) else st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            "path": _rel(p),
        })
    return out, _rel(base)


def save_upload(rel, file_storage):
    """file_storage: Flask FileStorage. Save into ROOT/rel with its filename."""
    base = _abs(rel)
    if not os.path.isdir(base):
        raise ValueError("目标不是目录")
    name = os.path.basename(file_storage.filename or "")
    if not name or name.startswith("."):
        raise ValueError("非法文件名")
    dest = os.path.join(base, name)
    tmp = dest + ".tmp"
    file_storage.save(tmp)
    os.chmod(tmp, 0o644)
    os.replace(tmp, dest)
    return _rel(dest)


def mkdir(rel, name):
    base = _abs(rel)
    if not os.path.isdir(base):
        raise ValueError("目标不是目录")
    name = os.path.basename((name or "").strip())
    if not name or name.startswith(".") or "/" in name:
        raise ValueError("非法目录名")
    p = os.path.join(base, name)
    os.makedirs(p, exist_ok=True)
    return _rel(p)


def delete(rel):
    p = _abs(rel)
    if p == ROOT:
        raise ValueError("不能删根目录")
    if os.path.isdir(p) and not os.path.islink(p):
        if os.listdir(p):
            raise ValueError("目录非空")
        os.rmdir(p)
    elif os.path.exists(p):
        os.remove(p)
    else:
        raise ValueError("不存在")


def download_path(rel):
    """Return absolute path for streaming download, or raise."""
    p = _abs(rel)
    if not os.path.isfile(p):
        raise ValueError("不是文件")
    return p, os.path.basename(p)


def read_file(rel, max_bytes=2_000_000):
    """Read a text file's content. Returns (content, is_binary, size).

    Raises ValueError if not a file or too large. Binary files are detected
    and returned with is_binary=True (content is a placeholder message).
    """
    p = _abs(rel)
    if not os.path.isfile(p):
        raise ValueError("不是文件")
    size = os.path.getsize(p)
    if size > max_bytes:
        raise ValueError(f"文件过大 ({size} bytes), 超过 {max_bytes} 限制")
    # Read first chunk to detect binary
    with open(p, "rb") as f:
        chunk = f.read(min(size, 8192))
    if b"\x00" in chunk:
        return ("[二进制文件，无法预览]", True, size)
    # Read full content as text
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        return (f.read(), False, size)
