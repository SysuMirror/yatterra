"""Rename keeps the public-port index. A node change copies when disks differ.

The group module is loaded against a temp root. kubectl, frpc and cred
stores are patched. Nothing here reads the live groups.json.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
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


class GroupMove(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        data = os.path.join(self.tmp.name, "groups-data")
        os.makedirs(data)
        env = patch.dict(os.environ, {
            "YATTERRA_ROOT": self.tmp.name,
            "YATTERRA_WEB_DIR": str(ROOT),
            "YATTERRA_GROUP_DATA_ROOT": data,
        })
        env.start()
        self.addCleanup(env.stop)
        for mod in ("siteconf", "groups", "hdd_quota"):
            sys.modules.pop(mod, None)
        self.siteconf = load("siteconf_move", "siteconf.py")
        self.audit = MagicMock()
        self.mods = patch.dict(sys.modules, {
            "siteconf": self.siteconf,
            "users": MagicMock(),
            "audit": self.audit,
            "req_estimate": MagicMock(),
        })
        self.mods.start()
        self.addCleanup(self.mods.stop)
        self.groups = load("groups_move", "groups.py")
        self.data = data
        self.calls = []
        self.groups.apply_group = lambda g: self.calls.append(("apply", g["name"], g.get("node")))
        self.groups.delete_group_k8s = lambda name, **kw: self.calls.append(("delete", name))
        self.groups.rewrite_frpc = lambda state: self.calls.append(("frpc", sorted(state["groups"])))
        self.groups.reload_frpc = lambda: self.calls.append(("reload",))
        self.groups.rewrite_nginx_web = lambda state: None
        # the rename job waits for the new pod's Ready condition; no cluster here
        self.groups._wait_pod_ready = lambda name, **kw: True
        self.groups._retarget_store_labels = lambda old, new: None

    def _group(self, name="alpha", node="wz8", gpus=None, type_="cpu"):
        home = os.path.join(self.data, name, "home")
        os.makedirs(home, exist_ok=True)
        Path(home, "note.txt").write_text("keep")
        return {
            "name": name,
            "index": 7,
            "type": type_,
            "gpus": gpus or [],
            "ssh_nodeport": 31007,
            "web_nodeport": 32007,
            "ssh_public": 22007,
            "web_public": 23007,
            "cpu": "2",
            "mem": "4Gi",
            "storage": "10Gi",
            "node": node,
            "owners": [],
            "members": [],
        }

    def _write(self, groups_map):
        Path(self.groups.STATE_FILE).write_text(json.dumps({"groups": groups_map}))

    def _state(self):
        return json.loads(Path(self.groups.STATE_FILE).read_text())["groups"]

    def test_rename_keeps_ports_and_moves_deploys(self):
        import deploys
        deploys.STATE_FILE = os.path.join(self.tmp.name, "deploys.json")
        deploys.save({"deploys": {"alpha": [{"id": "d1", "name": "job"}]}})
        self._write({"alpha": self._group()})
        got = self.groups.rename_group("alpha", "Beta_Two")
        self.assertEqual(got["name"], "beta-two")
        saved = self._state()
        self.assertNotIn("alpha", saved)
        self.assertEqual(saved["beta-two"]["index"], 7)
        self.assertEqual(saved["beta-two"]["ssh_public"], 22007)
        self.assertEqual(saved["beta-two"]["web_public"], 23007)
        self.assertEqual(saved["beta-two"]["ssh_nodeport"], 31007)
        self.assertTrue(os.path.isdir(os.path.join(self.data, "beta-two", "home")))
        self.assertFalse(os.path.exists(os.path.join(self.data, "alpha")))
        self.assertEqual(Path(os.path.join(self.data, "beta-two", "home", "note.txt")).read_text(), "keep")
        self.assertEqual(deploys.load()["deploys"]["beta-two"][0]["id"], "d1")
        self.assertNotIn("alpha", deploys.load()["deploys"])
        self.assertIn(("delete", "alpha"), self.calls)
        self.assertIn(("apply", "beta-two", "wz8"), self.calls)

    def test_rename_rejects_existing_and_restores_on_apply_failure(self):
        self._write({"alpha": self._group(), "taken": self._group("taken")})
        with self.assertRaises(ValueError):
            self.groups.rename_group("alpha", "taken")
        self.assertTrue(os.path.isdir(os.path.join(self.data, "alpha", "home")))

        def boom(g):
            raise RuntimeError("apply failed")
        self.groups.apply_group = boom
        with self.assertRaises(RuntimeError):
            self.groups.rename_group("alpha", "later")
        self.assertIn("alpha", self._state())
        self.assertNotIn("later", self._state())
        self.assertEqual(self._state()["alpha"]["ssh_public"], 22007)
        self.assertTrue(os.path.isdir(os.path.join(self.data, "alpha", "home")))
        self.assertFalse(os.path.exists(os.path.join(self.data, "later")))

    def test_gpu_mismatch_does_not_copy(self):
        self._write({"alpha": self._group(gpus=[0])})
        piped = []
        self.groups.nodes.pipe_root = lambda *a, **k: piped.append(a) or (True, "")
        with self.assertRaises(ValueError):
            self.groups.migrate_group("alpha", "xfusion")
        self.assertEqual(piped, [])
        self.assertEqual(self._state()["alpha"]["node"], "wz8")

    def test_copy_path_used_when_disks_differ(self):
        self._write({"alpha": self._group()})
        piped = []
        self.groups.nodes.shares_group_storage = lambda src, dst: False
        self.groups.nodes.pipe_root = lambda *a, **k: piped.append((a[0], a[1])) or (True, "")
        self.groups.nodes.run_on = lambda *a, **k: (True, "")
        import lifecycle
        with patch.object(lifecycle, "stop_group", return_value={"ok": True}), \
             patch.object(lifecycle, "start_group", return_value={"ok": True}):
            got = self.groups.migrate_group("alpha", "xfusion")
        self.assertEqual(got["node"], "xfusion")
        self.assertEqual(self._state()["alpha"]["node"], "xfusion")
        self.assertEqual(self._state()["alpha"]["ssh_public"], 22007)
        self.assertEqual(piped, [("wz8", "xfusion")])
        self.assertIn(("apply", "alpha", "xfusion"), self.calls)

    def test_failed_copy_keeps_old_node(self):
        self._write({"alpha": self._group()})
        self.groups.nodes.shares_group_storage = lambda src, dst: False
        self.groups.nodes.pipe_root = lambda *a, **k: (False, "stream broke")
        self.groups.nodes.run_on = lambda *a, **k: (True, "")
        import lifecycle
        with patch.object(lifecycle, "stop_group", return_value={"ok": True}), \
             patch.object(lifecycle, "start_group", return_value={"ok": True}):
            with self.assertRaises(RuntimeError):
                self.groups.migrate_group("alpha", "xfusion")
        self.assertEqual(self._state()["alpha"]["node"], "wz8")

    def test_shared_disk_does_not_stream(self):
        self._write({"alpha": self._group()})
        piped = []
        self.groups.nodes.shares_group_storage = lambda src, dst: True
        self.groups.nodes.pipe_root = lambda *a, **k: piped.append(a) or (True, "")
        import lifecycle
        with patch.object(lifecycle, "stop_group", return_value={"ok": True}), \
             patch.object(lifecycle, "start_group", return_value={"ok": True}):
            self.groups.migrate_group("alpha", "xfusion")
        self.assertEqual(piped, [])
        self.assertEqual(self._state()["alpha"]["node"], "xfusion")


class DeleteDisk(unittest.TestCase):
    def setUp(self):
        self.inner = GroupMove()
        self.inner.setUp()
        self.addCleanup(self.inner.doCleanups)

    def _patch_nodes(self, run_on):
        g = self.inner.groups
        patches = [
            patch.object(g.nodes, "run_on", run_on),
            patch.object(g.nodes, "names", lambda: ["npu", "spark", "wz8", "xfusion"]),
            patch.object(g.nodes, "profile", lambda node: {"k8s_node": "wz8"} if node == "npu" else {}),
            patch.object(g, "delete_group_k8s", lambda name: None),
            patch.object(g, "rewrite_frpc", lambda state: None),
            patch.object(g, "reload_frpc", lambda: None),
            patch.object(g, "rewrite_nginx_web", lambda state: None),
            patch.object(g, "_purge_group_artifacts", lambda name: None),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_delete_erases_each_machine_then_drops_the_record(self):
        g = self.inner.groups
        self.inner._write({"alpha": self.inner._group(node="xfusion")})
        calls = []

        def run_on(node, command, timeout=180):
            calls.append((node, command))
            return True, ""

        self._patch_nodes(run_on)
        g.remove_group("alpha")
        self.assertNotIn("alpha", self.inner._state())
        seen = [node for node, _cmd in calls]
        self.assertEqual(seen, ["spark", "wz8", "xfusion"])
        for _node, command in calls:
            self.assertIn("umount", command)
            self.assertIn("rm -rf", command)
            self.assertIn("/alpha", command)

    def test_leftover_disk_keeps_the_record(self):
        g = self.inner.groups
        self.inner._write({"alpha": self.inner._group()})

        def run_on(node, command, timeout=180):
            if node == "spark":
                return False, "残留 /data/alpha"
            return True, ""

        self._patch_nodes(run_on)
        with self.assertRaises(RuntimeError):
            g.remove_group("alpha")
        self.assertIn("alpha", self.inner._state())


class StorageProbe(unittest.TestCase):
    def test_matching_uuid_is_shared_and_a_miss_is_not(self):
        import nodes
        def run_on(node, command, timeout=20):
            if node == "xfusion":
                return False, "missing"
            return True, 'UUID="2862b34c" FSTYPE="ext4" SOURCE="/dev/sdb"\n'
        with patch.object(nodes, "run_on", run_on):
            self.assertFalse(nodes.shares_group_storage("spark", "xfusion"))
        def both(node, command, timeout=20):
            return True, 'UUID="2862b34c" FSTYPE="ext4" SOURCE="/dev/sdb"\n'
        with patch.object(nodes, "run_on", both):
            self.assertTrue(nodes.shares_group_storage("spark", "xfusion"))

    def test_nfs_client_of_the_group_directory_is_shared(self):
        import nodes
        root = nodes.siteconf.GROUP_DATA_ROOT.rstrip("/")
        def run_on(node, command, timeout=20):
            if node == "wz8":
                return True, (
                    'UUID="2862b34c" FSTYPE="ext4" SOURCE="/dev/sdb" TARGET="/mnt/sdb"\n'
                    "ADDRS=172.16.156.28 \n"
                )
            if node == "xfusion":
                return True, (
                    f'UUID="" FSTYPE="nfs4" SOURCE="172.16.156.28:{root}" '
                    f'TARGET="{root}"\n'
                    "ADDRS=172.16.156.13 \n"
                )
            return False, "missing"
        with patch.object(nodes, "run_on", run_on):
            self.assertTrue(nodes.shares_group_storage("wz8", "xfusion"))
            self.assertFalse(nodes.shares_group_storage("spark", "xfusion"))


class LocalPipe(unittest.TestCase):
    def test_pipe_root_copies_bytes_on_this_machine(self):
        import remote_hosts
        import shutil
        folder = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(folder, ignore_errors=True))
        out = os.path.join(folder, "out")
        ok, err = remote_hosts.pipe_root(
            None, "printf 'moved'",
            None, f"cat > {out}",
            timeout=20,
        )
        self.assertTrue(ok, err)
        self.assertEqual(Path(out).read_text(), "moved")
