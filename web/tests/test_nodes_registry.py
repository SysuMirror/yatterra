"""Node registry profiles for the xfusion and egress agents.

Loads the shipped web/nodes.py. No cluster, no remote_hosts.json.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load():
    spec = importlib.util.spec_from_file_location("nodes_under_test", ROOT / "nodes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NodeRegistry(unittest.TestCase):
    def setUp(self):
        self.n = load()

    def test_new_nodes_are_selectable_and_map_to_themselves(self):
        got = self.n.names()
        self.assertIn("xfusion", got)
        self.assertIn("egress", got)
        self.assertIn("wz8", got)
        self.assertIn("spark", got)
        self.assertIn("npu", got)
        self.assertEqual(self.n.k8s_node("xfusion"), "xfusion")
        self.assertEqual(self.n.k8s_node("egress"), "egress")
        self.assertEqual(self.n.k8s_node("npu"), "wz8")
        self.assertEqual(self.n.k8s_node("spark"), "spark")

    def test_placement_taint_matches_agent_taint(self):
        for node in ("xfusion", "egress", "spark"):
            text = self.n.placement_yaml(node)
            self.assertIn(f"yatterra/node: {node}\n", text)
            self.assertIn("key: yatterra/dedicated\n", text)
            self.assertIn(f"value: {node}\n", text)
            self.assertIn("effect: NoSchedule\n", text)
        self.assertEqual(self.n.placement_yaml(None), "")
        self.assertEqual(self.n.placement_yaml(""), "")

    def test_new_nodes_do_not_invent_gpus(self):
        for node in ("xfusion", "egress"):
            prof = self.n.profile(node)
            self.assertEqual(prof["arch"], "amd64")
            self.assertEqual(prof["gpu_ids"], [])
            self.assertFalse(prof["mps"])
            self.assertEqual(prof["ssh_host"], node)
            self.assertEqual(self.n.gpu_ids(node), [])
            self.assertFalse(self.n.is_local(node))

    def test_existing_profiles_unchanged(self):
        self.assertEqual(self.n.profile("wz8")["gpu_ids"], [0, 1, 2])
        self.assertTrue(self.n.profile("wz8")["mps"])
        self.assertIsNone(self.n.profile("wz8")["ssh_host"])
        self.assertEqual(self.n.profile("spark")["arch"], "arm64")
        self.assertTrue(self.n.profile("spark")["unified_memory"])
        self.assertEqual(self.n.profile("spark")["ssh_host"], "spark")
        self.assertEqual(self.n.gpu_ids("npu"), [])


if __name__ == "__main__":
    unittest.main()
