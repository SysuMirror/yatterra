"""ARTEX pod-scan API surface (api/security.py): auth gate + target resolution.

Loads the security blueprint standalone with ``users`` / ``audit`` / ``scan_svc``
/ ``groups`` / ``artex_svc`` stubbed — no DB, no app.py, no k8s.  Covers the new
"选 Pod → 内网渗透" endpoints:

- both routes are super-only (anonymous → 401, admin → 403);
- ``GET /artex/targets`` resolves each group's ClusterIP → internal URL, excludes
  ARTEX itself, and marks pods without a listening :8080 as ``selectable:false``;
- ``POST /artex/pod-scan`` resolves the target, creates the ARTEX task via
  ``create_pod_scan(pod, cluster_ip)`` and writes an audit record;
- bad inputs are rejected (empty/artex → 400, unknown group → 404, no service /
  not running → 409) without ever calling into ARTEX;
- an ARTEX failure surfaces as 502.
"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_USERS = {
    "root": {"username": "root", "role": "super"},
    "admin": {"username": "admin", "role": "admin"},
    "alice": {"username": "alice", "role": "user"},
}
_GROUPS = {
    "pod1": {"name": "pod1", "type": "cpu", "node": "auto", "index": 0, "internal": False},
    "pod2": {"name": "pod2", "type": "gpu", "node": "wz8", "index": 1, "internal": False},
    "artex": {"name": "artex", "type": "cpu", "node": "wz8", "index": 2, "internal": True},
}
_STATUSES = {"pod1": "Running", "pod2": "Running", "artex": "Running"}
_CIPS = {"pod1": "10.43.0.5", "pod2": "10.43.0.6", "artex": "10.43.0.7"}


def _stub_users():
    u = MagicMock()
    u.get_user.side_effect = lambda name: _USERS.get(name)
    u.verify_token.return_value = None
    u.has_perm.return_value = True
    return u


class SecurityArtexApi(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)

        sys.modules["users"] = _stub_users()

        audit = MagicMock()
        sys.modules["audit"] = audit
        self.audit = audit

        scan_svc = MagicMock()
        sys.modules["scan_svc"] = scan_svc

        groups = MagicMock()
        groups.load_state.return_value = {"groups": _GROUPS}
        groups.all_pod_statuses.return_value = dict(_STATUSES)
        groups.pod_status.side_effect = lambda n: _STATUSES.get(n, "NotFound")
        groups.service_cluster_ip.side_effect = lambda n: _CIPS.get(n, "")
        sys.modules["groups"] = groups
        self.groups = groups

        # real module so `artex_svc.ArtexError` is a catchable class
        artex = types.ModuleType("artex_svc")

        class ArtexError(RuntimeError):
            pass

        artex.ArtexError = ArtexError
        artex.status = MagicMock(return_value={"ok": True, "reachable": True, "tasks": []})
        artex.list_tasks = MagicMock(return_value={"tasks": [], "active": ""})
        artex.findings_stats = MagicMock(return_value={})
        artex.create_pod_scan = MagicMock(return_value={
            "task": {"id": "t1"}, "scope": {"id": "s1"},
            "target": "http://10.43.0.5:8080"})
        sys.modules["artex_svc"] = artex
        self.artex = artex

        # a fake `api` package so `from api._auth import require_auth` does not run
        # the real api/__init__.py (which pulls in k8s/minio/...)
        api_pkg = types.ModuleType("api")
        api_pkg.__path__ = [str(ROOT / "api")]
        sys.modules["api"] = api_pkg
        for name, rel in (("api._auth", "api/_auth.py"),
                          ("api.security", "api/security.py")):
            spec = importlib.util.spec_from_file_location(name, ROOT / rel)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            if name == "api.security":
                self.sec = mod
        # bypass the real network probe — every pod is "listening on :8080"
        self.sec._pod_web_up = lambda cip: True

        from flask import Flask
        app = Flask(__name__)
        app.secret_key = "test"
        app.register_blueprint(self.sec.security_bp)
        self.client = app.test_client()

    def _login(self, who):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = who

    # ── auth gate ────────────────────────────────────────────────
    def test_targets_anonymous_401(self):
        self.assertEqual(self.client.get("/api/security/artex/targets").status_code, 401)

    def test_pod_scan_anonymous_401(self):
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 401)

    def test_targets_admin_403(self):
        self._login("admin")
        self.assertEqual(self.client.get("/api/security/artex/targets").status_code, 403)

    def test_pod_scan_user_403(self):
        self._login("alice")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 403)

    # ── GET /artex/targets ───────────────────────────────────────
    def test_targets_resolves_internal_url_and_excludes_artex(self):
        self._login("root")
        body = self.client.get("/api/security/artex/targets").get_json()
        names = [t["name"] for t in body["targets"]]
        self.assertEqual(names, ["pod1", "pod2"])          # artex excluded, index order
        p1 = next(t for t in body["targets"] if t["name"] == "pod1")
        self.assertEqual(p1["internal_url"], "http://10.43.0.5:8080")
        self.assertEqual(p1["cluster_ip"], "10.43.0.5")
        self.assertTrue(p1["selectable"])

    def test_targets_marks_unserviceable_not_selectable(self):
        self.sec._pod_web_up = lambda cip: False
        self.groups.service_cluster_ip.side_effect = lambda n: "" if n == "pod2" else _CIPS.get(n, "")
        self._login("root")
        body = self.client.get("/api/security/artex/targets").get_json()
        p1 = next(t for t in body["targets"] if t["name"] == "pod1")
        p2 = next(t for t in body["targets"] if t["name"] == "pod2")
        self.assertFalse(p1["selectable"])                  # :8080 无响应
        self.assertFalse(p2["selectable"])                  # 无 ClusterIP
        self.assertIsNone(p2["internal_url"])

    # ── POST /artex/pod-scan ─────────────────────────────────────
    def test_pod_scan_happy_path(self):
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["target"], "http://10.43.0.5:8080")
        args = self.artex.create_pod_scan.call_args
        self.assertEqual(args.args[:2], ("pod1", "10.43.0.5"))
        self.audit.record.assert_called()
        self.assertEqual(self.audit.record.call_args.args[0], "api_artex_pod_scan")

    def test_pod_scan_empty_400(self):
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "  "})
        self.assertEqual(r.status_code, 400)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_artex_self_400(self):
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "artex"})
        self.assertEqual(r.status_code, 400)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_unknown_group_404(self):
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "nope"})
        self.assertEqual(r.status_code, 404)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_no_service_409(self):
        self.groups.service_cluster_ip.side_effect = lambda n: "" if n == "pod1" else _CIPS.get(n, "")
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 409)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_not_running_409(self):
        self.groups.pod_status.side_effect = lambda n: "Pending" if n == "pod1" else _STATUSES.get(n, "NotFound")
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 409)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_no_web_service_409(self):
        self.sec._pod_web_up = lambda cip: False
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 409)
        self.artex.create_pod_scan.assert_not_called()

    def test_pod_scan_artex_error_502(self):
        self.artex.create_pod_scan.side_effect = self.artex.ArtexError("boom")
        self._login("root")
        r = self.client.post("/api/security/artex/pod-scan", json={"pod": "pod1"})
        self.assertEqual(r.status_code, 502)


if __name__ == "__main__":
    unittest.main()
