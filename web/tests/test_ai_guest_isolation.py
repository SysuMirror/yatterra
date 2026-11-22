"""Guest AI-session isolation: _chat_owner() must scope a guest's chat
sessions / page runs to a per-browser nonce, so two anonymous visitors never
share a session bucket (ARTEX finding #138 — the guest principal is a single
globally-shared account row).

Loaded standalone with the blueprint's flat imports stubbed — no DB, no app.py.
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_DEPS = ["ai_service", "ai_chat_store", "insight", "kb_service",
         "middleware", "middleware.error_handler", "api", "api._auth"]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GuestChatOwnerTests(unittest.TestCase):
    def setUp(self):
        self.mp = patch.dict(sys.modules)
        self.mp.start()
        self.addCleanup(self.mp.stop)
        for m in _DEPS:
            sys.modules[m] = MagicMock()
        # api._auth must expose the names ai.py imports
        auth = sys.modules["api._auth"]
        auth.require_auth = lambda *a, **k: (lambda f: f)
        auth.current_username = lambda: "unset"
        auth.current_user_obj = lambda: {"username": "unset", "role": "user"}
        self.ai = load("ai_under_test", "api/ai.py")

        from flask import Flask
        self.app = Flask(__name__)
        self.app.secret_key = "test"

    def _owner(self, username, role, sess=None):
        self.ai.current_username = lambda: username
        self.ai.current_user_obj = lambda: {"username": username, "role": role}
        with self.app.test_request_context("/"):
            if sess:
                from flask import session
                for k, v in sess.items():
                    session[k] = v
            # first call may mint a nonce and write it to the session
            from flask import session
            first = self.ai._chat_owner()
            nonce = session.get("_guest_nonce")
            second = self.ai._chat_owner()
            return first, second, nonce, session

    def test_regular_user_uses_username(self):
        first, second, nonce, sess = self._owner("alice", "user")
        self.assertEqual(first, "alice")
        self.assertEqual(second, "alice")
        self.assertIsNone(nonce)

    def test_admin_uses_username(self):
        first, _, _, _ = self._owner("root", "admin")
        self.assertEqual(first, "root")

    def test_guest_is_scoped_and_stable(self):
        first, second, nonce, _ = self._owner("guest", "guest")
        self.assertTrue(first.startswith("guest#"))
        self.assertEqual(first, second)          # stable within a browser
        self.assertIsNotNone(nonce)

    def test_two_guest_browsers_differ(self):
        a, _, _, _ = self._owner("guest", "guest")
        b, _, _, _ = self._owner("guest", "guest")
        self.assertNotEqual(a, b)                # distinct nonces

    def test_guest_reuses_existing_nonce(self):
        first, second, nonce, _ = self._owner("guest", "guest",
                                              sess={"_guest_nonce": "deadbeef"})
        self.assertEqual(first, "guest#deadbeef")
        self.assertEqual(second, "guest#deadbeef")


if __name__ == "__main__":
    unittest.main()
