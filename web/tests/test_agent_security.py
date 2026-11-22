"""Agent-harness authorization tests: the root-equivalent host-tool role floor,
the read_file secret denylist, and drift between the local role-rank table and
ai_service._ROLE_RANK.

Never loads app.py, the DB, or production state — all flat-module deps of
agent.py are stubbed before import.
"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# flat modules agent.py / ai_service.py import at module top
_AGENT_DEPS = ["audit", "groups", "siteconf", "remote_hosts", "approvals",
               "llm", "agent_conf", "mcp_client", "users"]
_AI_DEPS = ["llm", "siteconf"]


class AgentSecurityTests(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict(sys.modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        for name in set(_AGENT_DEPS) | set(_AI_DEPS):
            sys.modules[name] = MagicMock()
        self.agent = load("agent_under_test", "agent.py")
        self.ai = load("aisvc_under_test", "ai_service.py")

    # --- role floor on root-equivalent host tools ---

    def test_host_tools_denied_for_guest_and_user(self):
        for tool in ("run", "run_remote", "read_file", "write_file",
                     "edit_file", "grep", "list_dir", "inspect"):
            for role in ("guest", "user"):
                self.assertIsNotNone(
                    self.agent._host_tool_denied(tool, "host", {"role": role}),
                    f"{tool} should be denied for {role}")

    def test_host_tools_allowed_for_admin_and_super(self):
        for tool in ("run", "read_file", "inspect"):
            for role in ("admin", "super"):
                self.assertIsNone(
                    self.agent._host_tool_denied(tool, "host", {"role": role}),
                    f"{tool} should be allowed for {role}")

    def test_pod_runner_is_not_floored(self):
        # build agent runs as `cloud` inside the pod, not root on the host
        self.assertIsNone(
            self.agent._host_tool_denied("run", "pod", {"role": "user"}))
        self.assertIsNone(
            self.agent._host_tool_denied("read_file", "pod", {"role": "guest"}))

    def test_missing_user_is_fail_closed(self):
        self.assertIsNotNone(self.agent._host_tool_denied("run", "host", None))

    def test_unknown_or_non_host_tool_is_unfloored(self):
        self.assertIsNone(self.agent._host_tool_denied("memory_save", "host",
                                                       {"role": "guest"}))
        self.assertIsNone(self.agent._host_tool_denied("web_search", "host",
                                                       {"role": "guest"}))

    def test_rank_table_matches_ai_service(self):
        self.assertEqual(self.agent._AGENT_ROLE_RANK, self.ai._ROLE_RANK)

    # --- read_file secret denylist ---

    def test_read_file_host_denies_secrets(self):
        for p in ("/opt/yatterra/.env", "/etc/shadow",
                  "/etc/rancher/k3s/k3s.yaml", "/root/.ssh/id_rsa"):
            ok, out = self.agent._read_file_host(p)
            self.assertFalse(ok, f"{p} should be denied")
            self.assertIn("安全限制", out)

    def test_read_file_host_denies_symlink_to_secret(self):
        link = os.path.join(tempfile.gettempdir(), "yt_sec_link")
        try:
            if os.path.islink(link) or os.path.exists(link):
                os.remove(link)
            os.symlink("/opt/yatterra/.env", link)
        except OSError:
            self.skipTest("cannot create symlink")
        try:
            ok, _ = self.agent._read_file_host(link)
            self.assertFalse(ok, "symlink to a secret must be denied")
        finally:
            os.remove(link)

    def test_read_file_host_allows_benign_file(self):
        fd, path = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(fd, "w") as f:
                f.write("hello world")
            ok, out = self.agent._read_file_host(path)
            self.assertTrue(ok)
            self.assertIn("hello world", out)
        finally:
            os.remove(path)

    # --- ops denylist: SSH-key backdoor / account / persistence primitives ---

    def test_ops_denied_blocks_ssh_key_backdoor(self):
        for cmd in (
            "echo 'ssh-rsa AAAA' >> /root/.ssh/authorized_keys",
            "tee -a /home/cloud/.ssh/authorized_keys < k.pub",
            "cp /tmp/k /root/.ssh/authorized_keys",
            "sed -i 's/old/new/' /root/.ssh/authorized_keys",
            "cat /home/cloud/.ssh/authorized_keys2",
        ):
            self.assertTrue(self.agent._ops_denied(cmd), cmd)

    def test_ops_denied_blocks_account_and_sudoers(self):
        for cmd in (
            "useradd -m hacker",
            "adduser hacker",
            "usermod -aG sudo hacker",
            "chpasswd",
            "passwd root",
            "gpasswd -a hacker sudo",
            "echo 'hacker ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/h",
            "visudo",
        ):
            self.assertTrue(self.agent._ops_denied(cmd), cmd)

    def test_ops_denied_blocks_persistence(self):
        for cmd in (
            "crontab -e",
            "echo '* * * * * sh /tmp/x' > /var/spool/cron/root",
            "echo x >> /etc/cron.d/backdoor",
            "echo x > /etc/systemd/system/evil.service",
        ):
            self.assertTrue(self.agent._ops_denied(cmd), cmd)

    def test_ops_denied_blocks_secret_reads_via_shell(self):
        for cmd in (
            "cat /opt/yatterra/.env",
            "grep -i secret /opt/yatterra/web/.env",
            "cat /opt/yatterra/llm.conf",
            "cat /root/.ssh/id_rsa",
            "cat /etc/shadow",
        ):
            self.assertTrue(self.agent._ops_denied(cmd), cmd)

    def test_ops_denied_allows_normal_ops(self):
        for cmd in (
            "df -h", "free -m", "docker ps",
            "systemctl restart k3s",
            "kubectl get pods -A",
            "echo hi > /tmp/x.txt",
            "echo log > /var/log/app.log",
            "journalctl -u yatterra-web -n 50",
        ):
            self.assertFalse(self.agent._ops_denied(cmd), cmd)

    # --- host write/edit path guard: SSH backdoor paths ---

    def test_host_write_denied_blocks_ssh_and_persistence_paths(self):
        for p in (
            "/root/.ssh/authorized_keys",
            "/home/cloud/.ssh/authorized_keys",
            "/home/wzhpc/.ssh/authorized_keys2",
            "/var/spool/cron/root",
            "/etc/sudoers.d/backdoor",
        ):
            self.assertIsNotNone(self.agent._host_write_denied(p), p)

    def test_host_write_denied_allows_benign_paths(self):
        for p in ("/tmp/ok.txt", "/var/log/x.log",
                  "/opt/yatterra/logs/a.log"):
            self.assertIsNone(self.agent._host_write_denied(p), p)


if __name__ == "__main__":
    unittest.main()
