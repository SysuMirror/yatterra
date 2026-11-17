"""Presence-driven deploy editing (``api.pods._deploy_edit_fields``).

The edit path replaces the old "contract-only" PUT: it must accept a partial
body and change only the keys present, so the legacy flexibility-contract call
(``{kind:'train', defer_ok:...}``) keeps working without wiping repo/branch.

Error paths call ``jsonify`` → an app context is provided for those cases only.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flask import Flask

import api.pods as pods_api
from middleware.error_handler import ApiError

REPO = "https://github.com/acme/widget.git"


def dep(**over):
    d = {
        "id": "abc12345", "name": "api", "source": "repo", "script": "",
        "repo": REPO, "branch": "main", "subdir": "", "token": "old-token",
        "mode": "service", "kind": "serve", "gpu": "0", "vram": "",
        "auto_deploy": False, "health": "", "health_timeout": 60,
        "env": {}, "webhook_secret": "",
    }
    d.update(over)
    return d


class EditFields(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = Flask(__name__)

    def call(self, d, body):
        with self.app.app_context():
            return pods_api._deploy_edit_fields(d, body)

    def assertErr(self, result, status=400):
        fields, err = result
        self.assertIsNone(fields)
        self.assertIsNotNone(err)
        self.assertEqual(err[1], status)

    # ── presence-driven ──────────────────────────────────────────────
    def test_contract_only_does_not_touch_repo_or_branch(self):
        fields, err = self.call(dep(), {"kind": "train", "defer_ok": True, "preempt_ok": False})
        self.assertIsNone(err)
        self.assertNotIn("repo", fields)
        self.assertNotIn("branch", fields)
        self.assertNotIn("token", fields)
        self.assertEqual(fields["kind"], "train")
        self.assertEqual(fields["env"]["DEFER_OK"], "true")
        self.assertEqual(fields["env"]["PREEMPT_OK"], "false")

    def test_empty_body_has_no_fields(self):
        fields, err = self.call(dep(), {})
        self.assertIsNone(err)
        self.assertEqual(fields, {})

    # ── validation ───────────────────────────────────────────────────
    def test_repo_valid_and_invalid(self):
        fields, err = self.call(dep(), {"repo": REPO, "branch": "dev"})
        self.assertIsNone(err)
        self.assertEqual(fields["repo"], REPO)
        self.assertEqual(fields["branch"], "dev")
        self.assertErr(self.call(dep(), {"repo": "http://github.com/a/b"}))

    def test_mode_and_kind_validation(self):
        self.assertErr(self.call(dep(), {"mode": "bogus"}))
        self.assertErr(self.call(dep(), {"kind": "bogus"}))
        fields, err = self.call(dep(), {"mode": "oneshot"})
        self.assertEqual(fields["mode"], "oneshot")

    def test_local_source_rejects_repo_and_validates_script(self):
        fields, err = self.call(dep(source="local", script="/home/cloud/a.sh"), {"repo": REPO, "branch": "x"})
        self.assertIsNone(err)
        self.assertNotIn("repo", fields)
        self.assertNotIn("branch", fields)
        fields, err = self.call(dep(source="local"), {"script": "/home/cloud/app/start.sh"})
        self.assertEqual(fields["script"], "/home/cloud/app/start.sh")
        self.assertErr(self.call(dep(source="local"), {"script": "/etc/passwd"}))

    # ── token semantics ──────────────────────────────────────────────
    def test_token_blank_keeps_and_value_overwrites(self):
        fields, _ = self.call(dep(), {"token": ""})
        self.assertNotIn("token", fields)          # blank → keep existing
        fields, _ = self.call(dep(), {"token": "  new-tok  "})
        self.assertEqual(fields["token"], "new-tok")
        fields, _ = self.call(dep(), {"token": None})
        self.assertEqual(fields["token"], "")      # explicit clear
        fields, _ = self.call(dep(), {"token": "x", "clear_token": True})
        self.assertEqual(fields["token"], "")

    # ── health_timeout ───────────────────────────────────────────────
    def test_health_timeout(self):
        fields, _ = self.call(dep(), {"health_timeout": "120"})
        self.assertEqual(fields["health_timeout"], 120)
        with self.assertRaises(ApiError):
            self.call(dep(), {"health_timeout": "abc"})
        with self.assertRaises(ApiError):
            self.call(dep(), {"health_timeout": "0"})

    # ── auto_deploy ──────────────────────────────────────────────────
    def test_auto_deploy_forced_false_for_local(self):
        fields, _ = self.call(dep(source="local"), {"auto_deploy": True})
        self.assertIs(fields["auto_deploy"], False)
        fields, _ = self.call(dep(), {"auto_deploy": True})
        self.assertIs(fields["auto_deploy"], True)

    def test_train_env_rebuilt_when_contract_keys_present(self):
        fields, _ = self.call(dep(kind="train"), {"kind": "train", "preempt_ok": True})
        self.assertIn("env", fields)
        self.assertEqual(fields["env"]["PREEMPT_OK"], "true")

    def test_unrelated_edit_keeps_env_on_train(self):
        # editing health on a train deploy must NOT wipe its flexibility contract
        fields, _ = self.call(dep(kind="train", env={"PREEMPT_OK": "false"}), {"health": "/health"})
        self.assertNotIn("env", fields)

    def test_serve_untouched_env(self):
        fields, _ = self.call(dep(), {"health": "/health"})
        self.assertNotIn("env", fields)


if __name__ == "__main__":
    unittest.main()
