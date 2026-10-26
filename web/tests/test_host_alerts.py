"""host_alerts: host disk/swap/GPU-temp/fleet/daemon checks.

Exercises the real claim+push path against a temp alert DB (no pushes leave the
box) and asserts at-most-once bucketing, so a persistent condition cannot storm
the admin's phone every 15s poll.
"""
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import host_alerts
import pwa_alerts


class _Usage:
    def __init__(self, used, total):
        self.used = used
        self.total = total
        self.free = total - used


class HostAlerts(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.t.name, "a.db")
        self._old_db = pwa_alerts.DB_PATH
        pwa_alerts.DB_PATH = self.db
        pwa_alerts.init_db()
        self.sent = []
        self._p = patch("api.push.send_to_users",
                        side_effect=lambda users, payload: self.sent.append((set(users), payload)) or {"sent": len(users)})
        self._p.start()
        self._p2 = patch.object(host_alerts, "_admins", return_value=["admin1"])
        self._p2.start()

    def tearDown(self):
        self._p.stop()
        self._p2.stop()
        pwa_alerts.DB_PATH = self._old_db
        self.t.cleanup()

    def _events(self):
        with pwa_alerts._connect() as db:
            rows = db.execute("SELECT event_key, kind, group_name, recipients "
                              "FROM alert_event ORDER BY event_key").fetchall()
        return [dict(r) for r in rows]

    # --- disk ------------------------------------------------------------- #
    def test_disk_fires_then_buckets(self):
        with patch.object(host_alerts.siteconf, "DISK_MOUNTS", ["/data"]), \
                patch("shutil.disk_usage", return_value=_Usage(96, 100)), \
                patch.object(host_alerts.time, "time", return_value=1000.0):
            self.assertEqual(host_alerts.check_disk(), 1)
            # same bucket -> deduped, no second push
            self.assertEqual(host_alerts.check_disk(), 0)
            # next bucket -> re-notifies
            with patch.object(host_alerts.time, "time", return_value=1000.0 + host_alerts.BUCKET_S):
                self.assertEqual(host_alerts.check_disk(), 1)
        evs = self._events()
        self.assertEqual(len(evs), 2)
        self.assertEqual({e["kind"] for e in evs}, {"host-disk"})
        self.assertEqual({e["group_name"] for e in evs}, {"platform"})
        self.assertEqual(json.loads(evs[0]["recipients"]), ["admin1"])
        self.assertEqual(len(self.sent), 2)

    def test_disk_quiet_below_threshold(self):
        with patch.object(host_alerts.siteconf, "DISK_MOUNTS", ["/data"]), \
                patch("shutil.disk_usage", return_value=_Usage(10, 100)):
            self.assertEqual(host_alerts.check_disk(), 0)
        self.assertEqual(self.sent, [])

    # --- swap ------------------------------------------------------------- #
    def test_swap_fires(self):
        meminfo = "MemTotal:       1024 kB\nSwapTotal:  1000 kB\nSwapFree:    100 kB\n"
        with patch("builtins.open", side_effect=self._meminfo_reader(meminfo)), \
                patch.object(host_alerts.time, "time", return_value=7.0):
            self.assertEqual(host_alerts.check_swap(), 1)
        self.assertEqual(self._events()[0]["kind"], "host-swap")

    def test_swap_no_swap_configured(self):
        meminfo = "MemTotal: 1024 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n"
        with patch("builtins.open", side_effect=self._meminfo_reader(meminfo)):
            self.assertEqual(host_alerts.check_swap(), 0)

    def _meminfo_reader(self, text):
        real_open = open

        def _open(path, *a, **k):
            if str(path) == "/proc/meminfo":
                return real_open(self._meminfo_file(text))
            return real_open(path, *a, **k)
        return _open

    def _meminfo_file(self, text):
        p = os.path.join(self.t.name, "meminfo")
        with open(p, "w") as f:
            f.write(text)
        return p

    # --- gpu temp --------------------------------------------------------- #
    def test_gpu_temp_fires_and_needs_sensor(self):
        with patch.object(host_alerts, "_gpu_temp", return_value=91.0), \
                patch.object(host_alerts.time, "time", return_value=5.0):
            self.assertEqual(host_alerts.check_gpu_temp(), 1)
        with patch.object(host_alerts, "_gpu_temp", return_value=None):
            self.assertEqual(host_alerts.check_gpu_temp(), 0)
        with patch.object(host_alerts, "_gpu_temp", return_value=40.0):
            self.assertEqual(host_alerts.check_gpu_temp(), 0)

    # --- fleet ------------------------------------------------------------ #
    def test_fleet_offline_and_stale(self):
        now = 10_000.0
        fake = types.ModuleType("fleet_monitor")
        fake.snapshot = lambda: {"hosts": [
            {"id": "a", "name": "A", "status": "online",
             "age_seconds": 5.0, "timestamp": now - 5},
            {"id": "b", "name": "B", "status": "offline", "age_seconds": 5.0,
             "timestamp": now - 5},
            {"id": "c", "name": "C", "status": "online",
             "age_seconds": now, "timestamp": 0.0},
        ]}
        with patch.dict(sys.modules, {"fleet_monitor": fake}), \
                patch.object(host_alerts.time, "time", return_value=now):
            self.assertEqual(host_alerts.check_fleet(), 2)
        kinds = {e["kind"] for e in self._events()}
        self.assertEqual(kinds, {"fleet-offline", "fleet-stale"})

    # --- daemons ---------------------------------------------------------- #
    def test_daemon_down_and_pressure_freshness(self):
        pf = os.path.join(self.t.name, "pressure.json")
        with open(pf, "w") as f:
            json.dump({"ts": 1000.0}, f)
        states = {"yatterra-web": True, "sse-pressure-writer": False}
        with patch.object(host_alerts, "WATCHED_UNITS", ("yatterra-web", "sse-pressure-writer")), \
                patch.object(host_alerts, "PRESSURE_FILE", pf), \
                patch.object(host_alerts, "_unit_active", side_effect=lambda u: states.get(u)), \
                patch.object(host_alerts.time, "time", return_value=1000.0 + host_alerts.PRESSURE_STALE_S + 10):
            self.assertEqual(host_alerts.check_daemons(), 2)  # unit down + stale signal
        idents = {e["event_key"] for e in self._events()}
        self.assertTrue(any("daemon-down:sse-pressure-writer" in k for k in idents))
        self.assertTrue(any("daemon-down:pressure-file" in k for k in idents))

    def test_unknown_unit_state_is_ignored(self):
        pf = os.path.join(self.t.name, "pressure.json")
        with open(pf, "w") as f:
            json.dump({"ts": 500.0}, f)
        with patch.object(host_alerts, "WATCHED_UNITS", ("nope.service",)), \
                patch.object(host_alerts, "PRESSURE_FILE", pf), \
                patch.object(host_alerts, "_unit_active", return_value=None), \
                patch.object(host_alerts.time, "time", return_value=510.0):
            self.assertEqual(host_alerts.check_daemons(), 0)

    # --- orchestrator ----------------------------------------------------- #
    def test_run_checks_survives_a_broken_check(self):
        with patch.object(host_alerts, "check_disk", side_effect=RuntimeError("boom")), \
                patch.object(host_alerts, "check_swap", return_value=0), \
                patch.object(host_alerts, "check_gpu_temp", return_value=0), \
                patch.object(host_alerts, "check_daemons", return_value=0), \
                patch.object(host_alerts, "check_fleet", return_value=0):
            self.assertEqual(host_alerts.run_checks(), 0)


if __name__ == "__main__":
    unittest.main()
