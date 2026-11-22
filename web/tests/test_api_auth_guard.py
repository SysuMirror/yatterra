"""API authorization-guard tests: require_auth(min_role=...) / min_role_guard
(the guest ban on /api/agents/* and /api/tokens) and the approvals blueprint's
guest lockdown + admin-only approver rule.

Loads api/_auth.py and approvals.py standalone with `users` stubbed — no DB,
no app.py.
"""
import importlib.util
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_USERS = {
    "g": {"username": "g", "role": "guest"},
    "u": {"username": "u", "role": "user"},
    "a": {"username": "a", "role": "admin"},
    "s": {"username": "s", "role": "super"},
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_users():
    u = MagicMock()
    u.get_user.side_effect = lambda name: _USERS.get(name)
    u.verify_token.return_value = None
    u.has_perm.return_value = True
    return u


class ApiAuthGuardTests(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)
        sys.modules["users"] = fake_users()
        self.auth = load("auth_under_test", "api/_auth.py")

        from flask import Flask, Blueprint
        app = Flask(__name__)
        app.secret_key = "test"

        @app.route("/guarded")
        @self.auth.require_auth(min_role="user")
        def guarded():
            return "ok"

        @app.route("/plain")
        @self.auth.require_auth()
        def plain():
            return "ok"

        bp = Blueprint("bp", __name__, url_prefix="/bp")

        @bp.before_request
        def _deny_guest():
            return self.auth.min_role_guard("user")

        @bp.route("/x")
        def bx():
            return "ok"

        app.register_blueprint(bp)
        self.client = app.test_client()

    def _login(self, who):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = who

    # --- require_auth(min_role=...) ---

    def test_anonymous_guarded_is_401(self):
        self.assertEqual(self.client.get("/guarded").status_code, 401)

    def test_guest_guarded_is_403(self):
        self._login("g")
        self.assertEqual(self.client.get("/guarded").status_code, 403)

    def test_user_and_above_guarded_is_200(self):
        for who in ("u", "a", "s"):
            self._login(who)
            self.assertEqual(self.client.get("/guarded").status_code, 200, who)

    def test_min_role_is_backward_compatible(self):
        # no min_role → guest still allowed wherever perms grant access
        self._login("g")
        self.assertEqual(self.client.get("/plain").status_code, 200)

    # --- min_role_guard (blueprint before_request) ---

    def test_guard_passes_anonymous_through(self):
        self.assertEqual(self.client.get("/bp/x").status_code, 200)

    def test_guard_blocks_guest(self):
        self._login("g")
        self.assertEqual(self.client.get("/bp/x").status_code, 403)

    def test_guard_allows_user(self):
        self._login("u")
        self.assertEqual(self.client.get("/bp/x").status_code, 200)

    # --- session absolute lifetime (sliding-renewal cap) ---

    def test_fresh_session_is_ok(self):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = "u"
            s["_login_at"] = time.time()
        self.assertEqual(self.client.get("/plain").status_code, 200)

    def test_stale_session_is_expired(self):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = "u"
            s["_login_at"] = time.time() - (self.auth.SESSION_MAX_AGE_S + 10)
        self.assertEqual(self.client.get("/plain").status_code, 401)


class SessionAbsoluteLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)
        sys.modules["users"] = fake_users()
        self.auth = load("auth_under_test_sess", "api/_auth.py")

    def test_legacy_session_without_stamp_never_expires(self):
        self.assertFalse(self.auth.session_age_exceeded({}))

    def test_recent_session_ok(self):
        self.assertFalse(
            self.auth.session_age_exceeded({"_login_at": time.time()}))

    def test_over_cap_expires(self):
        old = time.time() - (self.auth.SESSION_MAX_AGE_S + 60)
        self.assertTrue(self.auth.session_age_exceeded({"_login_at": old}))

    def test_garbage_stamp_is_treated_as_absent(self):
        self.assertFalse(self.auth.session_age_exceeded({"_login_at": "n/a"}))


class ApprovalsGuardTests(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)
        sys.modules["siteconf"] = MagicMock()
        sys.modules["users"] = fake_users()
        # approvals lazily imports cert_alerts, whose import starts watchdog
        # threads against a bogus (mocked) honeypot dir — stub it out.
        sys.modules["cert_alerts"] = MagicMock()
        self.approvals = load("approvals_under_test", "approvals.py")
        # keep the endpoints DB-free
        self.approvals.list_records = lambda **kw: []
        self.approvals.mode = lambda: "high"

        from flask import Flask
        app = Flask(__name__)
        app.secret_key = "test"
        app.register_blueprint(self.approvals.approvals_bp)
        self.client = app.test_client()

    def _login(self, who):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = who

    def test_anonymous_is_401(self):
        self.assertEqual(
            self.client.get("/api/agents/approvals").status_code, 401)

    def test_guest_is_403(self):
        self._login("g")
        self.assertEqual(
            self.client.get("/api/agents/approvals").status_code, 403)

    def test_user_is_403(self):
        # user holds infra.host but is no longer an approver
        self._login("u")
        self.assertEqual(
            self.client.get("/api/agents/approvals").status_code, 403)

    def test_admin_is_allowed(self):
        self._login("a")
        self.assertEqual(
            self.client.get("/api/agents/approvals").status_code, 200)


class PodExistenceOracleTests(unittest.TestCase):
    """require_pod must not let a zero-credential guest enumerate pod existence.

    ARTEX finding: GET /api/pods/{name} returned 403 for an existing pod the
    caller can't access but 404 for a missing one — a cross-tenant existence
    oracle. A guest (rank 0) must get one uniform response either way.
    """

    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)
        gu = fake_users()
        gu.can_pod.return_value = False      # caller is never a pod member
        sys.modules["users"] = gu
        gmod = MagicMock()
        gmod.load_state.return_value = {"groups": {"real-pod": {"name": "real-pod"}}}
        sys.modules["groups"] = gmod
        self.auth = load("auth_under_test_pod", "api/_auth.py")

        from flask import Flask
        app = Flask(__name__)
        app.secret_key = "test"

        @app.route("/p/<name>")
        @self.auth.require_pod("member")
        def p(name):
            return "ok"

        self.client = app.test_client()

    def _login(self, who):
        with self.client.session_transaction() as s:
            s["logged_in"] = True
            s["user"] = who

    def test_anonymous_is_uniformly_401(self):
        for n in ("real-pod", "ghost-pod"):
            self.assertEqual(self.client.get(f"/p/{n}").status_code, 401, n)

    def test_guest_is_uniform_403(self):
        self._login("g")
        real = self.client.get("/p/real-pod").status_code
        ghost = self.client.get("/p/ghost-pod").status_code
        self.assertEqual(real, 403)
        self.assertEqual(ghost, 403)
        # the whole point: guest cannot distinguish existing from missing
        self.assertEqual(real, ghost)


if __name__ == "__main__":
    unittest.main()
