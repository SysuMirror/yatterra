import hashlib
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publish_spa", HERE / "scripts/publish_spa.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)


def digest(root):
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file(): h.update(str(p.relative_to(root)).encode()); h.update(p.read_bytes())
    return h.hexdigest()


def fixture(root, *, asset=b"asset", index=None):
    (root / "assets").mkdir(parents=True)
    (root / "assets/app-abc.js").write_bytes(asset)
    (root / "icon.png").write_bytes(b"icon")
    (root / "manifest.webmanifest").write_text(json.dumps({"icons":[{"src":"/icon.png"}]}))
    (root / "index.html").write_text(index or '<script type="module" src="/assets/app-abc.js"></script>')
    (root / "sw.js").write_text('{"precache":[{"url":"assets/app-abc.js"},{"url":"icon.png"}]}')


class PublisherTests(unittest.TestCase):
    def roots(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        base = Path(td.name); return base / "stage", base / "live"

    def test_failed_validation_leaves_live_untouched(self):
        stage, live = self.roots(); fixture(live); before = digest(live)
        fixture(stage, index='<script src="/assets/../escape.js"></script>')
        with self.assertRaises(RuntimeError): mod.publish(stage, live)
        self.assertEqual(before, digest(live))

    def test_old_hash_preserved_and_same_content_idempotent(self):
        stage, live = self.roots(); fixture(live, asset=b"old"); fixture(stage, asset=b"old")
        mod.publish(stage, live); first = digest(live); self.assertEqual(live / "assets/app-abc.js".read_bytes() if False else (live / "assets/app-abc.js").read_bytes(), b"old")
        mod.publish(stage, live); self.assertEqual(first, digest(live))

    def test_collision_rejected(self):
        stage, live = self.roots(); fixture(live, asset=b"old"); fixture(stage, asset=b"new")
        with self.assertRaises(RuntimeError): mod.publish(stage, live)
        self.assertEqual((live / "assets/app-abc.js").read_bytes(), b"old")

    def test_symlink_rejected(self):
        stage, live = self.roots(); fixture(live); fixture(stage)
        (stage / "assets/link.js").symlink_to(stage / "assets/app-abc.js")
        with self.assertRaises(RuntimeError): mod.validate(stage, live)

    def test_missing_reference_rejected(self):
        stage, live = self.roots(); fixture(live); fixture(stage, index='<script src="/assets/missing.js"></script>')
        with self.assertRaises(RuntimeError): mod.validate(stage, live)

    def test_promotion_order_and_lock(self):
        stage, live = self.roots(); fixture(live); fixture(stage)
        order=[]; original=mod.atomic_copy
        mod.atomic_copy=lambda src,dst: (order.append(dst.name), original(src,dst))[1]
        try: mod.publish(stage, live)
        finally: mod.atomic_copy=original
        self.assertEqual(order[-2:], ["index.html", "sw.js"])
        held = live.parent / ("." + live.name + ".publish.lock")
        fd=os.open(held, os.O_CREAT|os.O_RDWR)
        import fcntl; fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            with self.assertRaises(RuntimeError): mod.publish(stage, live)
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

if __name__ == "__main__": unittest.main()
