"""Run: python3 -m unittest discover -s web/tests -v."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

# Resolve flat web modules independently of cwd and discovery order.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fleet_monitor as fleet
import fleet_probe as probe
import metrics


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

    def test_machine_identity_does_not_invent_gpus(self):
        import nodes
        xeon = probe.machine_identity('processor\t: 0\nmodel name\t: Intel Xeon\n', 'x86_64', 'FusionServer')
        self.assertEqual(xeon, {'arch': 'x86_64', 'cpu_model': 'Intel Xeon', 'product': 'FusionServer'})
        arm = probe.machine_identity('processor\t: 0\nmodel name\t: \nModel\t: NVIDIA GB10\n', 'aarch64', '')
        self.assertEqual(arm['arch'], 'aarch64')
        self.assertEqual(arm['cpu_model'], 'NVIDIA GB10')
        self.assertIsNone(arm['product'])
        spark = nodes.hardware_hint('spark', 'spark')
        self.assertEqual(spark['arch'], 'arm64')
        self.assertTrue(spark['unified_memory'])
        self.assertNotIn('gpu_ids', spark)
        self.assertEqual(nodes.hardware_hint('gpu4090', 'local')['arch'], 'amd64')
        self.assertEqual(nodes.hardware_hint('ssemarket', 'ssemarket'), {})
        row = fleet.annotate_hardware({
            'id': 'xfusion', 'name': 'xfusion',
            'data': {'machine': {'arch': 'x86_64', 'cpu_model': 'Xeon'}, 'gpus': [{'name': 'RTX 3090'}]},
        })
        self.assertEqual(row['hardware']['arch_source'], 'probe')
        self.assertEqual(row['accelerator_count'], 1)
        self.assertEqual(row['data']['gpus'][0]['name'], 'RTX 3090')
        bare = fleet.annotate_hardware({'id': 'spark', 'name': 'spark', 'data': None})
        self.assertEqual(bare['hardware']['arch'], 'arm64')
        self.assertEqual(bare['hardware']['arch_source'], 'registry')
        self.assertEqual(bare['accelerator_count'], 0)
        script = """
import { fleetCards, archLabel } from './frontend/src/lib/fleetMachines.ts'
const cards = fleetCards([
  {id:'local', name:'gpu4090', hardware:{arch:'x86_64'}, data:{gpus:[{index:0,name:'RTX 4090 D',utilization_pct:1,memory_used_bytes:1,memory_total_bytes:2}]}},
  {id:'xfusion', name:'xfusion', hardware:{arch:'amd64'}, data:{gpus:[{index:0,name:'RTX 3090'},{index:1,name:'RTX 3090'}]}},
  {id:'spark', name:'spark', hardware:{arch:'aarch64'}, data:{gpus:[{index:0,name:'NVIDIA GB10'}]}},
  {id:'egress', name:'egress', hardware:{arch:'x86_64'}, data:{gpus:[]}},
])
const label = cards.map((c) => c.hostName + ':' + (c.empty ? 'none' : c.name)).join(',')
const n3090 = cards.filter((c) => c.name === 'RTX 3090').length
if (n3090 !== 2) throw new Error('3090 count ' + n3090 + ' ' + label)
if (!label.includes('gpu4090:RTX 4090 D') || !label.includes('spark:NVIDIA GB10') || !label.includes('egress:none')) {
  throw new Error(label)
}
if (archLabel('aarch64') !== 'arm64' || archLabel('x86_64') !== 'amd64') throw new Error(archLabel('aarch64'))
const gb10 = cards.find((c) => c.name === 'NVIDIA GB10')
if (!gb10 || gb10.memTotalMiB != null) throw new Error('gb10 memory should stay null')
console.log(label)
console.log('gb10-mem-null')
"""
        run = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parents[1], text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.count('xfusion:RTX 3090'), 2, run.stdout)
        self.assertIn('gpu4090:RTX 4090 D', run.stdout)
        self.assertIn('spark:NVIDIA GB10', run.stdout)
        self.assertIn('egress:none', run.stdout)
        self.assertIn('gb10-mem-null', run.stdout)
        self.assertNotIn('gpu_ids', row)
        self.assertNotIn('gpu_ids', bare)
        print(run.stdout, end='')

    def test_gpu_units_and_unsupported_values(self):
        gpu = probe.parse_gpus('0, GPU-abc, NVIDIA X, 70, 1024, 2048, N/A, [Not Supported], 300')[0]
        self.assertEqual(gpu["memory_used_bytes"], 1024**3)
        self.assertIsNone(gpu["temperature_c"])
        self.assertIsNone(gpu["power_watts"])
        self.assertIsNone(probe.number("nan"))
        self.assertEqual(probe.cpu_percent((100, 40), (200, 60)), 80)
        self.assertIsNone(probe.cpu_percent((100, 40), (100, 40)))

    def test_shared_probe_collects_driver_pods_net_and_disk(self):
        """Parsers the sampler ships. A later node has no private collector."""
        self.assertNotIn("wz8", Path(probe.__file__).read_text())
        self.assertEqual(fleet.mounts_of({"id": "futurebox", "name": "futurebox", "kind": "remote"}), ["/"])
        gpu = probe.parse_gpus("0, GPU-abc, NVIDIA X, 70, 1024, 2048, 40, 100, 300, 550.54.15")[0]
        self.assertEqual(gpu["driver_version"], "550.54.15")
        blank = probe.parse_gpus("0, GPU-abc, NVIDIA X, 70, 1024, N/A, 40, 100, 300, N/A")[0]
        self.assertNotIn("driver_version", blank)
        self.assertIsNone(blank["memory_total_bytes"])
        net_before = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 1000 10 1 0 0 0 0 0 2000 20 0 1 0 0 0 0\n  veth1: 99999 9 0 0 0 0 0 0 99999 9 0 0 0 0 0 0\n"
        net_after = net_before.replace("eth0: 1000 10 1 0", "eth0: 3000 30 1 2").replace("2000 20 0 1", "2600 40 0 1")
        sample = probe.network_sample(net_before, net_after, 2)
        self.assertEqual(sample["rx_bytes"], 3000)
        self.assertEqual(sample["rx_bytes_per_sec"], 1000)
        self.assertEqual(sample["tx_bytes_per_sec"], 300)
        self.assertEqual(sample["rx_drop_pct"], round(100 * 1 / 11, 4))
        self.assertIsNone(probe.network_sample(None, None, 2)["rx_bytes"])
        self.assertIsNone(probe.counter_rate(50, 10, 1))
        disk_line = lambda sectors, writes: "8 2 sda2 4 0 %s 1 8 0 %s 1 0 10 20\n" % (sectors, writes)
        before = probe.parse_diskstats(disk_line(1000, 2000))
        after = probe.parse_diskstats(disk_line(1100, 2000))
        mountinfo = "36 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw,errors=remount-ro\n"
        disks = [{"mount": "/", "read_bytes": None, "write_bytes": None, "read_rate_bytes_sec": None, "write_rate_bytes_sec": None}]
        rolled = probe.fill_disk_rates(disks, mountinfo, before, after, 0.2, resolve=lambda path: path)
        self.assertEqual(disks[0]["read_bytes"], 1100 * 512)
        self.assertEqual(disks[0]["read_rate_bytes_sec"], round(100 * 512 / 0.2, 3))
        self.assertEqual(disks[0]["write_rate_bytes_sec"], 0.0)
        self.assertEqual(rolled["read_bytes_per_sec"], disks[0]["read_rate_bytes_sec"])
        reset = [{"mount": "/", "read_bytes": None, "write_bytes": None}]
        probe.fill_disk_rates(reset, mountinfo, after, before, 0.2, resolve=lambda path: path)
        self.assertIsNone(reset[0]["read_rate_bytes_sec"])
        missing = [{"mount": "/data", "read_bytes": None}]
        probe.fill_disk_rates(missing, mountinfo, before, after, 0.2, resolve=lambda path: path)
        self.assertIsNone(missing[0]["read_bytes"])
        cgroup = "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-podf478c2b7_69fe_4883_a776_ef0dd7b1a84a.slice/cri-containerd-abc.scope\n"
        apps = probe.parse_compute_apps("GPU-abc, 42, 128\nGPU-abc, 7, 64\nGPU-other, 9, 8\nGPU-abc, 3, [N/A]\n", {"GPU-abc": 0})
        pods = probe.attribute_pods(
            apps,
            {"42": cgroup, "7": "0::/user.slice/session.scope\n"},
            {"42": b"HOSTNAME=group-vision-7d8f9c-abcde\x00PATH=/\x00"},
            {},
        )
        self.assertEqual(list(pods), [0])
        self.assertEqual(pods[0][0]["mem"], 128)
        self.assertEqual(pods[0][0]["name"], "group-vision-7d8f9c-abcde")
        self.assertIsNone(pods[0][0]["util"])
        self.assertEqual(pods[0][0]["uid"], "f478c2b7-69fe-4883-a776-ef0dd7b1a84a")
        named = probe.attribute_pods(apps[:1], {"42": cgroup}, {}, {(0, "42"): 12.5})
        self.assertEqual(named[0][0]["util"], 12.5)
        self.assertIsNone(named[0][0]["name"])
        labeled = {"gpus": [{"index": 0, "pods": [{"uid": "f478c2b7-69fe-4883-a776-ef0dd7b1a84a", "name": None, "mem": 128, "util": None}, {"uid": "zzzzzzzz-aaaa-bbbb-cccc-ddddeeeeffff", "mem": 4}]}]}
        with patch.object(fleet, "pod_name_map", return_value={"f478c2b7-69fe-4883-a776-ef0dd7b1a84a": "group-vision-7d8f9c-abcde"}):
            fleet.label_probe_pods(labeled)
        self.assertEqual(labeled["gpus"][0]["pods"][0]["name"], "group-vision-7d8f9c-abcde")
        self.assertEqual(labeled["gpus"][0]["pods"][1]["name"], "pod-zzzzzzzz")
        kept = {"gpus": [{"pods": [{"uid": "abc", "name": "already", "mem": 1}]}]}
        with patch.object(fleet, "pod_name_map", return_value={"abc": "other-host-pod"}):
            fleet.label_probe_pods(kept)
        self.assertEqual(kept["gpus"][0]["pods"][0]["name"], "already")

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

    def test_four_hosts_keep_distinct_mounts(self):
        """Inventory plus the shipped probe: four hosts, per-host mounts, no secrets."""
        secret = "SECRET-DO-NOT-LEAK"
        config = Path(self.tmp.name) / "hosts.json"
        config.write_text(json.dumps([
            dict(name="spark", host="spark.example", user="monitor", password=secret, desc="nvme"),
            dict(name="egress", host="egress.example", user="monitor", password=secret, desc="egress",
                 mounts=["/", "/no-such-egress-disk"]),
            dict(name="xfusion", host="xfusion.example", user="monitor", password=secret, desc="xfusion",
                 mounts=["/var", "/opt"]),
        ]))
        usage = {
            "/": types.SimpleNamespace(total=1000, used=100, free=900),
            "/mnt/sdb": types.SimpleNamespace(total=8000, used=6400, free=1600),
            "/var": types.SimpleNamespace(total=2000, used=500, free=1500),
            "/opt": types.SimpleNamespace(total=4000, used=3000, free=1000),
        }

        def fake_usage(path):
            if path not in usage:
                raise OSError(2, "No such file or directory", path)
            return usage[path]

        real_run = subprocess.run

        def refuse_ssh(*args, **kwargs):
            cmd = args[0] if args else []
            head = cmd[0] if isinstance(cmd, (list, tuple)) and cmd else ""
            if head in ("ssh", "sshpass") or str(head).endswith("/ssh"):
                raise AssertionError("must not SSH")
            return real_run(*args, **kwargs)

        with patch.object(fleet, "CONFIG_PATH", str(config)), \
             patch.object(fleet.siteconf, "DISK_MOUNTS", ["/", "/mnt/sdb"]), \
             patch.dict("os.environ", {"YATTERRA_LOCAL_HOST_NAME": "wz8"}), \
             patch.object(probe.shutil, "disk_usage", side_effect=fake_usage), \
             patch.object(probe.time, "sleep", return_value=None), \
             patch.object(fleet.subprocess, "run", side_effect=refuse_ssh):
            hosts = fleet.inventory()
            self.assertEqual(len(hosts), 4)
            by_name = {h["name"]: h for h in hosts}
            self.assertEqual(set(by_name), {"wz8", "spark", "egress", "xfusion"})
            self.assertEqual(by_name["wz8"]["mounts"], ["/", "/mnt/sdb"])
            self.assertEqual(by_name["spark"]["mounts"], ["/"])
            self.assertNotIn("/mnt/sdb", by_name["spark"]["mounts"])
            self.assertEqual(by_name["egress"]["mounts"], ["/", "/no-such-egress-disk"])
            self.assertEqual(by_name["xfusion"]["mounts"], ["/var", "/opt"])
            samples = {}
            for host in hosts:
                view = fleet.public_host(host)
                self.assertEqual(set(view), {"id", "name", "kind", "desc"})
                self.assertNotIn("password", view)
                self.assertNotIn(secret, json.dumps(view))
                sampled = probe.collect(host["mounts"])
                self.assertNotIn(secret, json.dumps(sampled))
                samples[host["name"]] = sampled
            local = fleet.collect_host(by_name["wz8"])
            self.assertNotIn("password", local)
            self.assertNotIn(secret, json.dumps(local))
            self.assertEqual([d["mount"] for d in local["data"]["disks"]], ["/", "/mnt/sdb"])

        wz = samples["wz8"]["disks"]
        self.assertEqual([d["mount"] for d in wz], ["/", "/mnt/sdb"])
        self.assertNotEqual(wz[0]["used_bytes"], wz[1]["used_bytes"])
        self.assertNotEqual(wz[0]["total_bytes"], wz[1]["total_bytes"])
        self.assertGreater(len(wz), 1)
        spark = samples["spark"]["disks"]
        self.assertEqual([d["mount"] for d in spark], ["/"])
        self.assertFalse(any(d["mount"] == "/mnt/sdb" for d in spark))
        egress = samples["egress"]["disks"]
        self.assertEqual([d["mount"] for d in egress], ["/", "/no-such-egress-disk"])
        missing = next(d for d in egress if d["mount"] == "/no-such-egress-disk")
        sibling = next(d for d in egress if d["mount"] == "/")
        self.assertEqual(missing["error"], "Mount unavailable")
        self.assertEqual(sibling["used_bytes"], 100)
        self.assertEqual(sibling["total_bytes"], 1000)
        self.assertNotIn("error", sibling)
        xfusion = samples["xfusion"]["disks"]
        self.assertEqual([d["mount"] for d in xfusion], ["/var", "/opt"])
        self.assertNotEqual(xfusion[0]["used_bytes"], xfusion[1]["used_bytes"])
        self.assertNotEqual(xfusion[0]["total_bytes"], xfusion[1]["total_bytes"])
        self.assertNotEqual([d["mount"] for d in xfusion], ["/"])
        print("hosts=4 names=wz8,spark,egress,xfusion")
        print("wz8 mounts=/ /mnt/sdb used/total=%s/%s %s/%s distinct=yes collapsed=no" % (
            wz[0]["used_bytes"], wz[0]["total_bytes"], wz[1]["used_bytes"], wz[1]["total_bytes"]))
        print("spark mounts=/ invented_mnt_sdb=no disks=%s" % [d["mount"] for d in spark])
        print("egress missing=%s error=%s sibling_mount=%s sibling_used=%s sibling_total=%s" % (
            missing["mount"], missing["error"], sibling["mount"], sibling["used_bytes"], sibling["total_bytes"]))
        print("xfusion mounts=/var /opt used/total=%s/%s %s/%s collapsed_to_root=no" % (
            xfusion[0]["used_bytes"], xfusion[0]["total_bytes"], xfusion[1]["used_bytes"], xfusion[1]["total_bytes"]))
        print("public_view_secrets=no")


class MetricsTests(unittest.TestCase):
    def test_metric_rates_and_counter_reset(self):
        metrics._counter_snapshot = {"ts": 10.0,
                                     "net": {"rx_bytes": 1000, "tx_bytes": 2000, "rx_packets": 100, "tx_packets": 200,
                                             "rx_dropped": 1, "tx_dropped": 2, "rx_errors": 0, "tx_errors": 0},
                                     "disk": {"read_bytes": 4096, "write_bytes": 8192, "read_ops": 4, "write_ops": 8,
                                              "io_ms": 10, "weighted_io_ms": 20}}
        with patch.object(metrics.time, "monotonic", return_value=12.0), \
             patch.object(metrics, "_read_net_counters", return_value=({"rx_bytes": 3000, "tx_bytes": 2600,
                       "rx_packets": 140, "tx_packets": 220, "rx_dropped": 3, "tx_dropped": 2,
                       "rx_errors": 0, "tx_errors": 1}, {})), \
             patch.object(metrics, "_read_disk_counters", return_value={"read_bytes": 12288, "write_bytes": 12288,
                       "read_ops": 8, "write_ops": 10, "io_ms": 30, "weighted_io_ms": 50}):
            out = metrics._rate_metrics()
        self.assertEqual(out["network"]["rx_bytes_per_sec"], 1000)
        self.assertEqual(out["network"]["tx_packets_per_sec"], 10)
        self.assertEqual(out["disk"]["read_ops_per_sec"], 2)
        self.assertEqual(out["disk"]["busy_pct"], 1.0)

        metrics._counter_snapshot = {"ts": 12.0, "net": {"rx_bytes": 3000}, "disk": {"read_bytes": 12288}}
        with patch.object(metrics.time, "monotonic", return_value=13.0), \
             patch.object(metrics, "_read_net_counters", return_value=({"rx_bytes": 10, "tx_bytes": 0,
                       "rx_packets": 0, "tx_packets": 0, "rx_dropped": 0, "tx_dropped": 0,
                       "rx_errors": 0, "tx_errors": 0}, {})), \
             patch.object(metrics, "_read_disk_counters", return_value={"read_bytes": 1, "write_bytes": 0,
                       "read_ops": 0, "write_ops": 0, "io_ms": 0, "weighted_io_ms": 0}):
            out = metrics._rate_metrics()
        self.assertEqual(out["network"]["rx_bytes_per_sec"], 0)
        self.assertEqual(out["disk"]["read_bytes_per_sec"], 0)


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
