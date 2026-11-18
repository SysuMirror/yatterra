#!/usr/bin/env python3
"""HDD /data cap: size parsing and the mount the pod manifest actually emits."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hdd_quota
import groups


class StorageBytes(unittest.TestCase):
    def test_kubernetes_quantities(self):
        self.assertEqual(hdd_quota.storage_bytes("10Gi"), 10 * 1024 ** 3)
        self.assertEqual(hdd_quota.storage_bytes("1Ti"), 1024 ** 4)
        self.assertEqual(hdd_quota.storage_bytes("10"), 10 * 1024 ** 3)

    def test_script_uses_parsed_size_and_mountpoint(self):
        script = hdd_quota.ensure_script("demo", "10Gi")
        img, mnt = hdd_quota.paths("demo")
        self.assertIn(f"fallocate -l {10 * 1024 ** 3}", script)
        self.assertIn(img, script)
        self.assertIn(mnt, script)
        self.assertIn("mkfs.ext4", script)
        self.assertNotIn("10Gi", script)


class Manifest(unittest.TestCase):
    def _group(self, **extra):
        g = {
            "name": "quota-demo",
            "type": "cpu",
            "cpu": "1",
            "mem": "1Gi",
            "storage": "10Gi",
            "password": "x",
            "node": "auto",
        }
        g.update(extra)
        return g

    def test_ubuntu_pod_mounts_capped_data_dir(self):
        text = groups.deployment_yaml(self._group())
        self.assertIn("mountPath: /data", text)
        self.assertIn("/groups/quota-demo/data", text.replace(groups.GROUP_DATA_ROOT, "/groups"))
        self.assertIn("type: Directory", text)
        self.assertNotIn("data.img", text)
        self.assertIn("containerPort: 22", text)
        self.assertNotIn("containerPort: 8080", text)

    def test_windows_pod_has_no_data_mount(self):
        text = groups._windows_deployment_yaml(self._group(type="windows", name="win"))
        self.assertNotIn("mountPath: /data", text)
        self.assertIn("containerPort: 8080", text)


if __name__ == "__main__":
    unittest.main()
