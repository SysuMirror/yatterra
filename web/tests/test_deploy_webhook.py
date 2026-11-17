"""Per-deploy webhook secrets + match_webhook authorization.

Covers the change from a single platform-wide webhook secret to a per-deploy
``webhook_secret`` (with the global secret kept as a fallback so the live
auto_deploy deploys keep working).

No production file is touched: ``deploys.STATE_FILE`` points at a temp file and
``WEBHOOK_CONF`` is redirected so ``load_webhook_secret`` reads a stub value.
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import deploys

REPO = "https://github.com/acme/widget.git"


def github_headers(secret, body):
    mac = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return {"X-Hub-Signature-256": "sha256=" + mac}


class WebhookBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "deploys.json"
        self.conf = Path(self.tmp.name) / "webhook.conf"
        self.conf.write_text("[webhook]\nsecret = global-secret\n")
        p = mock.patch.object(deploys, "STATE_FILE", str(self.state))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(deploys, "WEBHOOK_CONF", str(self.conf))
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.dict(os.environ, {}, clear=False)
        p.start()
        self.addCleanup(p.stop)
        os.environ.pop("WEBHOOK_SECRET", None)

    def add(self, name, repo=REPO, branch="main", auto=True):
        return deploys.add("pod1", {"name": name, "repo": repo, "branch": branch,
                                    "auto_deploy": auto})


class SignatureCheck(WebhookBase):
    def test_github_hmac(self):
        body = b'{"ref":"refs/heads/main"}'
        self.assertTrue(deploys._signature_ok("github", github_headers("s3cr3t", body), body, "s3cr3t"))
        self.assertFalse(deploys._signature_ok("github", github_headers("wrong", body), body, "s3cr3t"))
        self.assertFalse(deploys._signature_ok("github", {"X-Hub-Signature-256": "nope"}, body, "s3cr3t"))
        self.assertFalse(deploys._signature_ok("github", github_headers("s3cr3t", body), body, ""))

    def test_gitee_token(self):
        body = b"{}"
        self.assertTrue(deploys._signature_ok("gitee", {"X-Gitee-Token": "tok"}, body, "tok"))
        self.assertFalse(deploys._signature_ok("gitee", {"X-Gitee-Token": "other"}, body, "tok"))
        self.assertFalse(deploys._signature_ok("gitee", {}, body, "tok"))

    def test_verify_for_deploy_uses_own_secret(self):
        dep = {"webhook_secret": "abc"}
        body = b"{}"
        self.assertTrue(deploys.verify_for_deploy("gitee", {"X-Gitee-Token": "abc"}, body, dep))
        self.assertFalse(deploys.verify_for_deploy("gitee", {"X-Gitee-Token": "abc"}, body, {}))


class MatchWebhook(WebhookBase):
    def test_add_mints_secret_when_auto_deploy(self):
        dep = self.add("api")
        self.assertEqual(len(dep["webhook_secret"]), 32)
        self.assertEqual(len(self.add("manual", auto=False)["webhook_secret"]), 0)

    def test_per_deploy_secret_authorizes_matching_repo_only(self):
        dep = self.add("api")
        body = b"{}"
        dep2 = self.add("other", repo="https://github.com/acme/other.git")
        # secret of dep2 cannot trigger dep1's repo
        hdr = github_headers(dep2["webhook_secret"], body)
        matched, mode = deploys.match_webhook("github", hdr, body, REPO, "main")
        self.assertEqual(matched, [])
        self.assertIsNone(mode)
        # dep1's own secret does
        hdr = github_headers(dep["webhook_secret"], body)
        matched, mode = deploys.match_webhook("github", hdr, body, REPO, "main")
        self.assertEqual(mode, "per_deploy")
        self.assertEqual([(g, d["name"]) for g, d in matched], [("pod1", "api")])

    def test_global_secret_falls_back_to_all_candidates(self):
        self.add("api")
        self.add("api2", branch="main")
        body = b"{}"
        # blank out per-deploy secrets to emulate the 6 live legacy deploys
        for g, d in deploys.find_by_repo_branch(REPO, "main"):
            deploys.update(g, d["id"], webhook_secret="")
        hdr = github_headers("global-secret", body)
        matched, mode = deploys.match_webhook("github", hdr, body, REPO, "main")
        self.assertEqual(mode, "global")
        self.assertEqual(sorted(d["name"] for _, d in matched), ["api", "api2"])

    def test_wrong_secret_rejected(self):
        self.add("api")
        body = b"{}"
        matched, mode = deploys.match_webhook("github", github_headers("nope", body), body, REPO, "main")
        self.assertEqual((matched, mode), ([], None))

    def test_non_matching_branch_and_auto_false_ignored(self):
        dep = self.add("api")
        self.add("off", auto=False)
        body = b"{}"
        hdr = github_headers(dep["webhook_secret"], body)
        self.assertEqual(deploys.match_webhook("github", hdr, body, REPO, "dev"), ([], None))
        self.assertEqual(deploys.match_webhook("github", hdr, body, "https://github.com/acme/off.git", "main"), ([], None))

    def test_empty_branch_not_matched(self):
        self.add("api", branch="")
        body = b"{}"
        self.assertEqual(deploys.find_by_repo_branch(REPO, ""), [])


class Rotate(WebhookBase):
    def test_rotate_returns_new_and_persists(self):
        dep = self.add("api")
        old = dep["webhook_secret"]
        new = deploys.rotate_webhook_secret("pod1", dep["id"])
        self.assertEqual(len(new), 32)
        self.assertNotEqual(new, old)
        self.assertEqual(deploys.get("pod1", dep["id"])["webhook_secret"], new)

    def test_rotate_missing_is_empty(self):
        self.assertEqual(deploys.rotate_webhook_secret("pod1", "nope"), "")


class Source(WebhookBase):
    def test_map(self):
        self.assertEqual(deploys.webhook_source_for_repo("https://github.com/a/b"), "github")
        self.assertEqual(deploys.webhook_source_for_repo("https://gitee.com/a/b.git"), "gitee")
        self.assertEqual(deploys.webhook_source_for_repo("https://gitlab.com/a/b"), "")
        self.assertEqual(deploys.webhook_source_for_repo(""), "")

    def test_state_is_json(self):
        self.add("api")
        json.loads(self.state.read_text())


if __name__ == "__main__":
    unittest.main()
