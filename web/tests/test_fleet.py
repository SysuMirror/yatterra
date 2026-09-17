"""Run: PYTHONPATH=web python3 -m unittest discover -s web/tests -v."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import fleet_monitor as fleet
import fleet_probe as probe


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = fleet.Store(Path(self.tmp.name) / "metrics.db")
        self.store.initialize()

    def test_history_durable_bounded_and_pruned(self):
        for ts in range(101):
            self.store.append(dict(id="local", timestamp=ts, status="online", data=None))
        reopened = fleet.Store(self.store.path)
        rows = reopened.history("local", 0, 100, 10)
        self.assertEqual(len(rows), 10)
        self.assertEqual([rows[0]["timestamp"], rows[-1]["timestamp"]], [0, 100])
        self.assertEqual(reopened.latest("local")["timestamp"], 100)
        self.assertEqual(reopened.history("unknown", 0, 100), [])
        reopened.prune(fleet.RETENTION + 50)
        self.assertEqual(reopened.history("local", 0, 100)[0]["timestamp"], 50)

    def test_history_validation(self):
        for since, until, limit in [(0, 10, 1), (10, 0, 10), (0, float("nan"), 10), (0, fleet.RETENTION+1, 10)]:
            with self.assertRaises(ValueError): self.store.history("local", since, until, limit)

    def test_missing_database_and_stale(self):
        with patch.object(fleet, "inventory", return_value=[dict(id="local", name="test", kind="local")]):
            row = fleet.snapshot(fleet.Store(Path(self.tmp.name)/"absent.db"))["hosts"][0]
            self.assertEqual(row["status"], "unknown")
            self.assertTrue(row["stale"])
            self.store.append(dict(id="local", timestamp=1, data=None, status="offline"))
            self.assertTrue(fleet.snapshot(self.store)["hosts"][0]["stale"])

    def test_gpu_units_and_unsupported_values(self):
        gpu = probe.parse_gpus('0, GPU-abc, NVIDIA X, 70, 1024, 2048, N/A, [Not Supported], 300')[0]
        self.assertEqual(gpu["memory_used_bytes"], 1024**3)
        self.assertIsNone(gpu["temperature_c"])
        self.assertIsNone(gpu["power_watts"])
        self.assertIsNone(probe.number("nan"))
        self.assertEqual(probe.cpu_percent((100, 40), (200, 60)), 80)
        self.assertIsNone(probe.cpu_percent((100, 40), (100, 40)))

    def test_timeout_isolated_and_redacted(self):
        cfg = dict(id="remote", name="remote", kind="remote", host="example.org", password="SECRET")
        with patch.object(fleet.subprocess, "run", side_effect=subprocess.TimeoutExpired("SECRET", 25)):
            sample = fleet.collect_host(cfg)
        self.assertEqual(sample["status"], "offline")
        self.assertNotIn("SECRET", json.dumps(sample))
        self.assertNotIn("password", sample)

    def test_password_not_in_argv(self):
        cfg = dict(id="remote", name="remote", kind="remote", host="example.org", password="SECRET")
        data = dict(cpu={}, memory={}, swap={}, errors={}, disks=[], gpus=[])
        with patch.object(fleet.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=json.dumps(data))) as run:
            self.assertEqual(fleet.collect_host(cfg)["status"], "online")
        self.assertNotIn("SECRET", str(run.call_args.args))
        self.assertEqual(run.call_args.kwargs["env"]["SSHPASS"], "SECRET")
        self.assertEqual(run.call_args.kwargs["timeout"], 25)

    def test_local_partial(self):
        with patch.object(probe, "collect", return_value={"errors": {"disk": "unavailable"}}):
            self.assertEqual(fleet.collect_host(dict(id="local", name="local", kind="local"))["status"], "partial")

    def test_inventory_rejects_option_injection(self):
        config=Path(self.tmp.name)/"hosts.json"
        config.write_text(json.dumps([dict(name="remote", host="-oProxyCommand=evil")]))
        with patch.object(fleet, "CONFIG_PATH", str(config)):
            with self.assertRaises(ValueError): fleet.inventory()


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load only the real infra blueprint/auth code, avoiding application startup
        # (which initializes unrelated production services and worker threads).
        cls.modules = patch.dict(sys.modules)
        cls.modules.start()
        for name in ("users", "host_health", "remote_hosts", "metrics", "cpu_stats", "gpu_stats", "minio_svc", "db_svc", "proxy_map", "audit"):
            sys.modules[name] = types.ModuleType(name)
        api = types.ModuleType("api")
        api.__path__ = [str(Path(__file__).resolve().parents[1]/"api")]
        sys.modules["api"] = api
        sys.modules.pop("api._auth", None)
        from api import _auth
        spec = importlib.util.spec_from_file_location("fleet_test_infra", Path(api.__path__[0])/"infra.py")
        cls.infra = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.infra)
        from flask import Flask
        from middleware.error_handler import register_error_handlers
        cls.app = Flask(__name__)
        cls.app.secret_key = "test"
        cls.app.register_blueprint(cls.infra.infra_bp)
        register_error_handlers(cls.app)
        cls.auth = _auth

    @classmethod
    def tearDownClass(cls): cls.modules.stop()

    def test_authentication_and_permission(self):
        client = self.app.test_client()
        for path in ("/api/infra/fleet", "/api/infra/fleet/local/history"):
            self.assertEqual(client.get(path).status_code, 401)
            with patch.object(self.auth, "_resolve_user", return_value={"username": "test"}):
                self.assertEqual(client.get(path).status_code, 403)

    def test_cached_snapshot_and_history_validation(self):
        client = self.app.test_client()
        with patch.object(self.auth, "_resolve_user", return_value={"username": "test"}), patch.object(self.auth.users, "has_perm", return_value=True, create=True), patch.object(fleet, "inventory", return_value=[dict(id="local")]), patch.object(fleet, "snapshot", return_value={"hosts": []}), patch.object(fleet, "collect_host", side_effect=AssertionError("HTTP must not collect")):
            self.assertEqual(client.get("/api/infra/fleet").json, {"hosts": []})
            self.assertEqual(client.get("/api/infra/fleet/missing/history").status_code, 404)
            for query in ("limit=1", "since=nan", "until=inf", "range=bad", "since=2&until=1", "limit=abc"):
                self.assertEqual(client.get("/api/infra/fleet/local/history?"+query).status_code, 400)
            with patch.object(fleet.Store, "history", return_value=[]) as history:
                response = client.get("/api/infra/fleet/local/history?since=1&until=2&limit=10")
                self.assertEqual(response.status_code, 200)
                history.assert_called_once_with("local", 1., 2., 10)

            with patch.object(self.infra._time, "time", return_value=1000):
                with patch.object(fleet.Store, "history", return_value=[]) as history:
                    response = client.get("/api/infra/fleet/local/history?until=2000")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json["until"], 1000)
                    self.assertEqual(response.json["since"], -2600)
                    history.assert_called_once_with("local", -2600., 1000., 240)


if __name__ == "__main__": unittest.main()
