#!/usr/bin/env python3
"""Stage and publish the SPA without ever cleaning the live asset directory.

Publication is per-file atomicity, not whole-release atomicity: a crash during
stable-file promotion can leave index.html and sw.js from different releases.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit, unquote

FRONTEND = Path(__file__).resolve().parents[1]
WEB = FRONTEND.parent
STAGING = WEB / ".spa-staging"
LIVE = WEB / "static" / "spa"
IMMUTABLE_DIR = "assets"
STABLE = {"index.html", "sw.js"}
REF_RE = re.compile(r"(?:src|href)=[\"']([^\"']+)[\"']", re.I)
SW_URL_RE = re.compile(r'"url"\s*:\s*("(?:[^"\\]|\\.)*")')


def fail(message: str) -> None:
    raise RuntimeError(message)


def regular_tree(root: Path) -> list[Path]:
    if not root.is_dir() or root.is_symlink():
        fail(f"root is not a real directory: {root}")
    files = []
    for p in root.rglob("*"):
        if p.is_symlink():
            fail(f"symlink is not allowed: {p.relative_to(root)}")
        if p.is_file():
            files.append(p)
        elif not p.is_dir():
            fail(f"non-regular path is not allowed: {p.relative_to(root)}")
    return files


def safe_root(root: Path) -> Path:
    root = Path(os.path.abspath(root))
    for part in (root, *root.parents):
        if part.is_symlink(): fail(f"symlink root/ancestor: {part}")
    return root


def rel_path(value: str) -> str | None:
    parts = urlsplit(value)
    if parts.scheme in {"https", "http", "data", "mailto", "tel"} or parts.netloc:
        return None
    if parts.scheme: fail(f"unsupported reference: {value}")
    path = unquote(parts.path)
    if not path: return None
    if "\\" in path or "\x00" in path or ".." in path.split("/"):
        fail(f"path traversal or invalid reference: {value}")
    rel = PurePosixPath(path.lstrip("/")).as_posix()
    if rel == ".": fail(f"reference is not an asset: {value}")
    return rel


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def references(staging: Path) -> set[str]:
    found: set[str] = set()
    index = staging / "index.html"
    if not index.is_file():
        fail("staging is missing required index.html")
    html = index.read_text(encoding="utf-8")
    for value in REF_RE.findall(html):
        rel = rel_path(value)
        if rel:
            found.add(rel)
    sw = staging / "sw.js"
    if not sw.is_file():
        fail("staging is missing required sw.js")
    # Workbox injectManifest emits JSON precache records in this project's sw.js.
    worker = sw.read_text(encoding="utf-8")
    urls = SW_URL_RE.findall(worker)
    if not urls or "__WB_MANIFEST" in worker:
        fail("missing or unsupported generated service-worker precache manifest")
    for value in urls:
        rel = rel_path(json.loads(value))
        if rel: found.add(rel)
    manifest_path = staging / "manifest.webmanifest"
    if not manifest_path.is_file(): fail("missing required manifest.webmanifest")
    manifest = json.loads(manifest_path.read_text())
    # start_url, scope and shortcut URLs are application routes, not files.
    def icons(obj):
        for icon in obj.get("icons", []) + obj.get("screenshots", []):
            rel = rel_path(icon["src"])
            if rel: found.add(rel)
    icons(manifest)
    for shortcut in manifest.get("shortcuts", []): icons(shortcut)
    for rel in found:
        target = staging / rel
        if not target.is_file() or target.is_symlink():
            fail(f"missing local entry asset: /{rel}")
    return found


def validate(staging: Path, live: Path) -> list[Path]:
    staging, live = safe_root(staging), safe_root(live)
    static = safe_root(WEB / "static")
    if staging == live or staging in live.parents or live in staging.parents:
        fail("staging and live must be disjoint")
    if staging == static or static in staging.parents:
        fail("staging must be outside web/static")
    files = regular_tree(staging)
    names = {p.relative_to(staging).as_posix() for p in files}
    for required in STABLE:
        if required not in names:
            fail(f"staging is missing required {required}")
    references(staging)
    if live.exists():
        regular_tree(live)
    for p in files:
        rel = p.relative_to(staging).as_posix()
        old = live / rel
        for parent in old.parents:
            if parent == live.parent: break
            if parent.exists() and not parent.is_dir(): fail(f"non-directory live ancestor: {parent}")
        if old.exists() and (old.is_symlink() or not old.is_file()):
            fail(f"live path is not a regular file: {rel}")
        # Immutable assets must never be replaced with different bytes.
        if rel.startswith(IMMUTABLE_DIR + "/") and old.is_file() and file_digest(p) != file_digest(old):
            fail(f"immutable asset collision: {rel}")
    return files


@contextlib.contextmanager
def publish_lock(live: Path):
    safe_root(live)
    lock_path = live.parent / ("." + live.name + ".publish.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail(f"publication lock is held: {lock_path}")
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def atomic_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{dst.name}.", dir=dst.parent)
    try:
        with os.fdopen(fd, "wb") as out, src.open("rb") as inp:
            shutil.copyfileobj(inp, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, dst)
    finally:
        with contextlib.suppress(FileNotFoundError): os.unlink(tmp)


def publish(staging: Path, live: Path) -> None:
    with publish_lock(live):
        # Revalidate after acquiring the lock to close races with another publisher.
        files = validate(staging, live)
        ordered = sorted(files, key=lambda p: (p.relative_to(staging).as_posix() in STABLE, p.name))
        stable = [p for p in ordered if p.relative_to(staging).as_posix() in STABLE]
        regular = sorted((p for p in ordered if p not in stable), key=lambda p: (p.relative_to(staging).parts[0] != IMMUTABLE_DIR, str(p)))
        for p in regular:
            atomic_copy(p, live / p.relative_to(staging))
        for p in sorted(stable, key=lambda p: p.name == "sw.js"):
            atomic_copy(p, live / p.relative_to(staging))


def build() -> None:
    safe_root(STAGING)
    STAGING.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="release-", dir=STAGING))
    env = os.environ.copy()
    env["SPA_OUT_DIR"] = str(stage)
    vite = FRONTEND / "node_modules" / ".bin" / "vite"
    if not vite.is_file(): fail(f"missing local Vite executable: {vite}")
    subprocess.run([str(vite), "build"], cwd=FRONTEND, env=env, check=True)
    validate(stage, LIVE)
    print(stage)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("build", "validate", "publish"))
    parser.add_argument("--staging", type=Path, default=None)
    args = parser.parse_args()
    try:
        if args.action == "build": build()
        else:
            if args.staging is None: fail("--staging is required (use the build output path)")
            if args.action == "validate": validate(args.staging, LIVE)
            else: publish(args.staging, LIVE)
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as e:
        print(f"publish-spa: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__": raise SystemExit(main())
