"""Planner for new cpu, gpu, and unified-memory nodes.

Run from /opt/yatterra/web:
  python3 -m unittest tests.test_node_install -v
"""
import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

import node_install
import nodes


class NodeInstallPlan(unittest.TestCase):
    def test_three_architectures_register_like_the_sampler(self):
        specs = {
            'cpu': dict(name='plan-cpu', kind='cpu', mounts=['/', '/data'], ssh_target='plan-cpu.example'),
            'gpu': dict(name='plan-gpu', kind='gpu', mounts=['/'], ssh_target='plan-gpu.example'),
            'unified': dict(name='plan-um', kind='unified-memory', mounts=['/', '/srv/nvme'], ssh_target='plan-um.example'),
        }
        plans = {key: node_install.plan_node(**spec) for key, spec in specs.items()}
        cpu, gpu, unified = plans['cpu'], plans['gpu'], plans['unified']

        self.assertFalse(cpu['profile']['advertise_nvidia_gpu'])
        self.assertFalse(cpu['profile']['unified_memory'])
        self.assertEqual(cpu['profile']['accelerator'], 'none')
        self.assertIsNone(cpu['profile']['discrete_vram_bytes'])

        self.assertTrue(gpu['profile']['advertise_nvidia_gpu'])
        self.assertFalse(gpu['profile']['unified_memory'])
        self.assertEqual(gpu['profile']['accelerator'], 'discrete')
        self.assertIsNone(gpu['profile']['discrete_vram_bytes'])

        self.assertTrue(unified['profile']['unified_memory'])
        self.assertEqual(unified['profile']['accelerator'], 'unified')
        self.assertIsNone(unified['profile']['discrete_vram_bytes'])
        self.assertFalse(unified['profile']['advertise_nvidia_gpu'])

        self.assertEqual(cpu['profile']['disk_mounts'], ['/', '/data'])
        self.assertEqual(gpu['profile']['disk_mounts'], ['/'])
        self.assertEqual(unified['profile']['disk_mounts'], ['/', '/srv/nvme'])
        for plan in plans.values():
            self.assertNotIn('/mnt/sdb', plan['profile']['disk_mounts'])
            self.assertEqual(plan['registration']['profile_key'], plan['name'])
            self.assertEqual(plan['registration']['ssh_host'], plan['name'])
            self.assertEqual(plan['registration']['remote_hosts_name'], plan['name'])
            self.assertEqual(plan['registration']['probe'], 'fleet_probe.collect')
            self.assertEqual(plan['registration']['collector'], 'fleet_monitor.collect_host')
            self.assertIsNone(plan['registration']['per_host_collector'])
            rendered = node_install.render_plan(plan)
            self.assertNotIn('def collect_%s' % plan['name'], rendered)
            self.assertNotIn('password', rendered.lower())

        own = node_install.plan_node('plan-disk', 'cpu', ['/', '/mnt/sdb'], 'plan-disk.example')
        self.assertEqual(own['profile']['disk_mounts'], ['/', '/mnt/sdb'])

        old = os.environ.get('YATTERRA_NODES_JSON')
        os.environ['YATTERRA_NODES_JSON'] = json.dumps({
            plan['name']: node_install.registry_profile(plan) for plan in plans.values()
        })
        try:
            for plan in plans.values():
                self.assertEqual(nodes.disk_mounts(plan['name']), plan['profile']['disk_mounts'])
                hint = nodes.hardware_hint(plan['name'], plan['name'])
                self.assertEqual(bool(hint.get('unified_memory')), plan['profile']['unified_memory'])
                self.assertNotIn('gpu_ids', hint)
        finally:
            if old is None:
                os.environ.pop('YATTERRA_NODES_JSON', None)
            else:
                os.environ['YATTERRA_NODES_JSON'] = old

        source = (ROOT / 'node_install.py').read_text()
        for banned in ('wz8', 'spark', 'xfusion', 'egress', '/mnt/sdb'):
            self.assertNotIn(banned, source)
        script = (ROOT / 'scripts' / 'install-node.sh').read_text()
        self.assertNotIn('ssh ', script)
        self.assertIn('node_install.py', script)

    def test_check_mode_refuses_to_apply(self):
        run = subprocess.run(
            [sys.executable, str(ROOT / 'node_install.py'), '--kind', 'cpu', '--name', 'plan-cpu', '--ssh', 'plan-cpu.example', '--mount', '/'],
            cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(run.stdout, '')
        self.assertIn('without --check', run.stderr)


if __name__ == '__main__':
    unittest.main()
