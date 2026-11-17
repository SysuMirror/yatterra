"""Deploy write routes accept Pod members (not just owners).

Deploy create/edit/delete/run/stop were lowered from ``owner`` to ``member``;
Pod settings and member management stay owner-only.  Loaded with ``users`` and
``groups`` stubbed, and the deploy store redirected to a temp file — no DB, no
app.py.
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flask import Flask, request

import api._auth as auth_mod
import api.pods as pods_api
import deploys
import groups


def resolve_user():
    name = request.headers.get("X-Test-User")
    return {"username": name} if name else None


# Levels each test user holds on pod "demo".
_GRANTS = {"member": {"member"}, "owner": {"owner", "member"}, "outsider": set()}


def fake_users():
    u = mock.MagicMock()
    u.can_pod.side_effect = lambda user, pod, level: level in _GRANTS.get(user.get("username"), set())
    return u


class DeployPerms(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = str(Path(self.tmp.name) / "deploys.json")

        for p in (
            mock.patch.object(deploys, "STATE_FILE", self.state),
            mock.patch.object(pods_api, "users", fake_users()),
            mock.patch.object(auth_mod, "users", fake_users()),
            mock.patch.object(auth_mod, "_resolve_user", resolve_user),
            mock.patch.object(groups, "load_state",
                              lambda: {"groups": {"demo": {"name": "demo", "members": {}}}}),
            mock.patch.object(pods_api, "audit", mock.MagicMock()),
            mock.patch.object(deploys, "run", mock.MagicMock(return_value=True)),
            mock.patch.object(deploys, "stop", mock.MagicMock(return_value=True)),
            mock.patch.object(deploys, "delete", mock.MagicMock(return_value=True)),
            mock.patch.object(deploys, "status", mock.MagicMock(return_value={"state": "stopped"})),
            mock.patch.object(deploys, "run_bounded", mock.MagicMock(return_value=(True, ""))),
        ):
            p.start()
            self.addCleanup(p.stop)

        self.dep = deploys.add("demo", {"name": "api", "repo": "https://github.com/acme/widget.git",
                                        "branch": "main", "auto_deploy": True})
        app = Flask(__name__)
        app.register_blueprint(pods_api.pods_bp, url_prefix="/pods")
        app.config["TESTING"] = True
        self.c = app.test_client()

    def req(self, method, path, user=None, json=None):
        h = {"X-Test-User": user} if user else {}
        fn = getattr(self.c, method)
        return fn(path, headers=h, json=json)

    # ── auth gate ────────────────────────────────────────────────────
    def test_anonymous_is_401(self):
        self.assertEqual(self.req("post", "/pods/demo/deploys", json={}).status_code, 401)

    def test_outsider_is_403(self):
        r = self.req("post", f"/pods/demo/deploys/{self.dep['id']}/run", user="outsider")
        self.assertEqual(r.status_code, 403)

    # ── member write parity ──────────────────────────────────────────
    def test_member_can_edit(self):
        r = self.req("put", f"/pods/demo/deploys/{self.dep['id']}",
                     user="member", json={"branch": "dev", "health": "/health"})
        self.assertEqual(r.status_code, 200)
        d = deploys.get("demo", self.dep["id"])
        self.assertEqual(d["branch"], "dev")
        self.assertEqual(d["repo"], "https://github.com/acme/widget.git")  # untouched

    def test_member_can_run_stop_delete(self):
        did = self.dep["id"]
        self.assertEqual(self.req("post", f"/pods/demo/deploys/{did}/run", user="member").status_code, 200)
        self.assertEqual(self.req("post", f"/pods/demo/deploys/{did}/stop", user="member").status_code, 200)
        self.assertEqual(self.req("delete", f"/pods/demo/deploys?id={did}", user="member").status_code, 200)

    def test_member_can_create(self):
        r = self.req("post", "/pods/demo/deploys", user="member",
                     json={"name": "api2", "source": "repo", "repo": "https://gitee.com/acme/x.git",
                           "branch": "main", "auto_deploy": True})
        self.assertIn(r.status_code, (200, 201))
        created = [d for d in deploys.list_for("demo") if d["name"] == "api2"]
        self.assertEqual(len(created), 1)
        self.assertEqual(len(created[0]["webhook_secret"]), 32)  # minted per-deploy

    # ── webhook credential endpoints ─────────────────────────────────
    def test_member_can_view_and_rotate_webhook(self):
        did = self.dep["id"]
        r = self.req("get", f"/pods/demo/deploys/{did}/webhook", user="member")
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertTrue(body["secret"])
        self.assertIn("/deploy/webhook?source=github", body["url"])
        old = body["secret"]
        r = self.req("post", f"/pods/demo/deploys/{did}/webhook/rotate", user="member")
        self.assertEqual(r.status_code, 200)
        self.assertNotEqual(r.get_json()["secret"], old)
        self.assertNotIn("report_token", r.get_json())

    def test_pod_lifecycle_stays_owner_only(self):
        # Pod 设置/生命周期仍限负责人：member 无权启停整个 Pod
        r = self.req("post", "/pods/demo/stop", user="member")
        self.assertEqual(r.status_code, 403)

    def test_list_never_leaks_secrets(self):
        r = self.req("get", "/pods/demo/deploys", user="member")
        self.assertEqual(r.status_code, 200)
        raw = r.get_data(as_text=True)
        self.assertNotIn(self.dep["webhook_secret"], raw)
        self.assertNotIn(self.dep["report_token"], raw)


if __name__ == "__main__":
    unittest.main()
