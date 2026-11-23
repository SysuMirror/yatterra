"""Shipped chart mappings: per-host GPU series and CPU versus memory marks."""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = ["node", "--experimental-strip-types", "--input-type=module", "-e"]


def _node(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(NODE + [script], cwd=ROOT, text=True, capture_output=True)


class ConsoleChartTests(unittest.TestCase):
    def test_accelerator_series_is_per_host_and_skips_null_memory(self):
        gpu = (ROOT / "frontend/src/routes/infra/gpu.tsx").read_text()
        self.assertIn("acceleratorSeries", gpu)
        self.assertIn("attributionForCard", gpu)
        self.assertNotIn("hostId === 'local' ? gpuSeries", gpu)
        self.assertNotIn("gpu.hostId === 'local'", gpu)
        script = """
import { acceleratorSeries, attributionForCard } from './frontend/src/lib/acceleratorSeries.ts'
const mib = (n) => n * 1024 * 1024
const localSamples = [
  { id: 'local', data: { gpus: [
    { index: 0, utilization_pct: 80, memory_used_bytes: mib(100), memory_total_bytes: mib(24576) },
    { index: 1, utilization_pct: 3, memory_used_bytes: mib(10), memory_total_bytes: mib(24576) },
  ] } },
  { id: 'local', data: { gpus: [
    { index: 0, utilization_pct: 70, memory_used_bytes: mib(110), memory_total_bytes: mib(24576) },
  ] } },
]
const remoteSamples = [
  { id: 'xfusion', data: { gpus: [
    { index: 0, utilization_pct: 16, memory_used_bytes: mib(20), memory_total_bytes: mib(24576) },
  ] } },
  { id: 'xfusion', data: { gpus: [
    { index: 0, utilization_pct: 18, memory_used_bytes: mib(21), memory_total_bytes: mib(24576) },
  ] } },
]
const sparkSamples = [
  { id: 'spark', data: { gpus: [{ index: 0, id: 'gb10', utilization_pct: 0, memory_used_bytes: 0, memory_total_bytes: null }] } },
  { id: 'spark', data: { gpus: [{ index: 0, id: 'gb10', utilization_pct: 1, memory_used_bytes: null, memory_total_bytes: null }] } },
]
const total = mib(24576)
const local = acceleratorSeries(localSamples, { index: 0, memTotalBytes: total })
const remote = acceleratorSeries(remoteSamples, { index: 0, memTotalBytes: total })
const spark = acceleratorSeries(sparkSamples, { index: 0, memTotalBytes: null })
if (remote.util.join(',') !== '16,18') throw new Error('remote util ' + remote.util.join(','))
if (local.util.join(',') !== '80,70') throw new Error('local util ' + local.util.join(','))
if (remote.mem.join(',') !== '20,21') throw new Error('remote mem ' + remote.mem)
if (local.mem.join(',') !== '100,110') throw new Error('local mem ' + local.mem)
if (spark.mem !== null) throw new Error('null-total card plotted memory ' + JSON.stringify(spark.mem))
if (spark.util.join(',') !== '0,1') throw new Error('spark util ' + spark.util.join(','))
const reports = [
  { hostId: 'local', index: 0, pods: [{ name: 'qwen', mem: 100, util: 1 }], groups: ['qwen'] },
  { hostId: 'xfusion', index: 0, pods: [{ name: 'vision', mem: 5, util: 2 }], groups: ['vision'] },
]
const borrowed = attributionForCard({ hostId: 'xfusion', index: 0 }, reports)
const quiet = attributionForCard({ hostId: 'spark', index: 0 }, reports)
const own = attributionForCard({ hostId: 'local', index: 0 }, reports)
if (borrowed.pods?.[0]?.name !== 'vision') throw new Error('xfusion pods ' + JSON.stringify(borrowed))
if (borrowed.pods.some((pod) => pod.name === 'qwen')) throw new Error('copied local pods')
if (quiet.pods !== undefined || quiet.groups !== undefined) throw new Error('invented spark pods ' + JSON.stringify(quiet))
if (own.pods?.[0]?.name !== 'qwen') throw new Error('local pods ' + JSON.stringify(own))
const prefer = attributionForCard({ hostId: 'local', index: 0 }, [
  { hostId: 'local', index: 0, pods: [{ name: 'pod-aaaaaaaa', mem: 1, util: null }] },
  { hostId: 'local', index: 0, pods: [{ name: 'qwen', mem: 9, util: 1 }], groups: ['qwen'] },
])
if (prefer.pods?.[0]?.name !== 'qwen') throw new Error('local group report lost ' + JSON.stringify(prefer))
const split = attributionForCard({ hostId: 'local', index: 0 }, [
  { hostId: 'local', index: 0, pods: [], groups: ['qwen-3-8-flash-next', 'operator'] },
  { hostId: 'local', index: 0, pods: [{ name: 'group-qwen-3-8-flash-next-7676648f6-7w2hj', mem: 23920, util: null }] },
])
if (split.pods?.[0]?.name !== 'qwen-3-8-flash-next' || split.pods?.[0]?.mem !== 23920) throw new Error('empty groups hid memory ' + JSON.stringify(split))
if (!split.groups?.includes('operator')) throw new Error('assignment groups dropped ' + JSON.stringify(split))
const quietGroups = attributionForCard({ hostId: 'xfusion', index: 0 }, [
  { hostId: 'xfusion', index: 0, pods: [], groups: ['vision'] },
])
if (quietGroups.pods !== undefined) throw new Error('empty pods became a donut ' + JSON.stringify(quietGroups))
if (quietGroups.groups?.[0] !== 'vision') throw new Error('groups lost ' + JSON.stringify(quietGroups))
const sparkRam = 128 * 1024 * 1024 * 1024
const unified = acceleratorSeries([
  { data: { gpus: [{ index: 0, utilization_pct: 0, memory_used_bytes: null, memory_total_bytes: null, pods: [{ mem: 100 }, { mem: 20 }] }] } },
  { data: { gpus: [{ index: 0, utilization_pct: 1, memory_used_bytes: null, memory_total_bytes: null, pods: [{ mem: 90 }] }] } },
], { index: 0, memTotalBytes: sparkRam })
if (unified.mem?.join(',') !== '120,90') throw new Error('unified pod memory ' + JSON.stringify(unified.mem))
if (unified.util.join(',') !== '0,1') throw new Error('unified util ' + unified.util.join(','))
const hostPool = acceleratorSeries([
  { data: { memory: { used_bytes: mib(70000), total_bytes: mib(122547) }, gpus: [{ index: 0, utilization_pct: 0, memory_used_bytes: null, memory_total_bytes: null, pods: [{ mem: 10 }] }] } },
  { data: { memory: { used_bytes: mib(71000), total_bytes: mib(122547) }, gpus: [{ index: 0, utilization_pct: 2, memory_used_bytes: null, memory_total_bytes: null }] } },
], { index: 0, memTotalBytes: mib(122547), memSource: 'host' })
if (hostPool.mem?.join(',') !== '70000,71000') throw new Error('host meminfo series ' + JSON.stringify(hostPool.mem))
const deviceIgnoresHost = acceleratorSeries([
  { data: { memory: { used_bytes: mib(70000) }, gpus: [{ index: 0, utilization_pct: 1, memory_used_bytes: mib(20), memory_total_bytes: mib(24576) }] } },
  { data: { memory: { used_bytes: mib(71000) }, gpus: [{ index: 0, utilization_pct: 1, memory_used_bytes: mib(21), memory_total_bytes: mib(24576) }] } },
], { index: 0, memTotalBytes: mib(24576), memSource: 'device' })
if (deviceIgnoresHost.mem?.join(',') !== '20,21') throw new Error('device used host ram ' + JSON.stringify(deviceIgnoresHost.mem))
console.log('remote-util=' + remote.util.join(','))
console.log('remote-mem=' + remote.mem.join(','))
console.log('spark-mem-null')
console.log('pods-stay-on-host')
"""
        run = _node(script)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("remote-util=16,18", run.stdout)
        self.assertIn("remote-mem=20,21", run.stdout)
        self.assertIn("spark-mem-null", run.stdout)
        self.assertIn("pods-stay-on-host", run.stdout)
        self.assertIn("gpu.unified && ramBytes", gpu)
        self.assertNotIn("series.util.length > 1", gpu)
        self.assertIn("memSource: gpu.unified && gpu.memTotalMiB == null ? 'host' : 'device'", gpu)
        print(run.stdout, end="")

    def test_host_charts_keep_cpu_and_memory_series(self):
        metrics = (ROOT / "frontend/src/components/domain/ClusterMetrics.tsx").read_text()
        console = (ROOT / "frontend/src/routes/index.tsx").read_text()
        self.assertIn("hostChartMarks", metrics)
        self.assertIn("hostMarks.cpu.series", metrics)
        self.assertIn("hostMarks.memory.series", metrics)
        self.assertIn("consoleStatIcons", console)
        self.assertIn("statMarks.memory.icon", console)
        self.assertIn("statMarks.disk.icon", console)
        script = """
import { hostChartMarks, consoleStatIcons } from './frontend/src/lib/hostCharts.ts'
const cpu = [11, 22, 33]
const mem = [40, 50, 60]
const marks = hostChartMarks(cpu, mem)
if (marks.cpu.series.join(',') !== '11,22,33') throw new Error('cpu series ' + marks.cpu.series.join(','))
if (marks.memory.series.join(',') !== '40,50,60') throw new Error('mem series ' + marks.memory.series.join(','))
if (marks.cpu.label !== '主机 CPU' || marks.cpu.icon !== 'cpu') throw new Error('cpu mark ' + marks.cpu.label + marks.cpu.icon)
if (marks.memory.label !== '主机内存' || marks.memory.icon !== 'memory') throw new Error('mem mark ' + marks.memory.label + marks.memory.icon)
if (marks.cpu.series.join(',') === marks.memory.series.join(',')) throw new Error('series swapped')
const icons = consoleStatIcons()
if (icons.memory.icon !== 'memory') throw new Error('memory icon ' + icons.memory.icon)
if (icons.disk.icon !== 'disk') throw new Error('disk icon ' + icons.disk.icon)
if (icons.memory.icon === 'disk' || icons.disk.icon === 'memory') throw new Error('icons swapped')
if (icons.cpu.icon !== 'cpu') throw new Error('cpu icon ' + icons.cpu.icon)
console.log('cpu-series=' + marks.cpu.series.join(','))
console.log('mem-series=' + marks.memory.series.join(','))
console.log('memory-icon=' + icons.memory.icon)
console.log('disk-icon=' + icons.disk.icon)
"""
        run = _node(script)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("cpu-series=11,22,33", run.stdout)
        self.assertIn("mem-series=40,50,60", run.stdout)
        self.assertIn("memory-icon=memory", run.stdout)
        self.assertIn("disk-icon=disk", run.stdout)
        print(run.stdout, end="")


    def test_remote_machine_vitals_match_probe_fields(self):
        host = (ROOT / "frontend/src/routes/infra/host.tsx").read_text()
        self.assertIn("machineVitals", host)
        script = """
import { machineVitals } from './frontend/src/lib/machineVitals.ts'
const gib = 1024 ** 3
const v = machineVitals({
  cpu: { count: 64, usage_pct: 12.5, load1: 1.25, load5: 1.1, load15: 0.9 },
  memory: { usage_pct: 41.2, used_bytes: gib, total_bytes: 2 * gib },
  swap: { used_bytes: 0, total_bytes: 1024 ** 2 },
  disks: [
    { mount: '/', usage_pct: 11, used_bytes: 1000, total_bytes: 9000 },
    { mount: '/mnt/sdb', usage_pct: 88, used_bytes: 8 * gib, total_bytes: 10 * gib },
  ],
  uptime_seconds: 90000,
  nvidia: { driver_version: '550.54.15', count: 2 },
  network: { rx_bytes_per_sec: 1000, tx_bytes_per_sec: null },
  disk_io: { read_bytes_per_sec: 4096, write_bytes_per_sec: 0 },
})
if (v.cores !== 64 || v.cpuPct !== 12.5) throw new Error('cpu ' + v.cores + ' ' + v.cpuPct)
if (v.load1 !== 1.25 || v.load5 !== 1.1 || v.load15 !== 0.9) throw new Error('load')
if (v.memPct !== 41.2 || !v.memUsed || !v.memTotal) throw new Error('mem ' + v.memUsed)
if (v.disks.length !== 2 || v.disks[1].mount !== '/mnt/sdb' || v.disks[1].usedPct !== 88) throw new Error('disks')
if (v.uptime !== '1d 1h') throw new Error('uptime ' + v.uptime)
if (v.swapUsed !== '0 B' || !v.swapTotal) throw new Error('swap ' + v.swapUsed)
if (v.driver !== '550.54.15' || v.netRx !== 1000 || v.netTx !== null || v.diskRead !== 4096 || v.diskWrite !== 0) throw new Error('rates ' + JSON.stringify(v))
const quiet = machineVitals({})
if (quiet.load1 !== null || quiet.disks.length !== 0 || quiet.uptime !== null || quiet.driver !== null || quiet.netRx !== null || quiet.diskRead !== null) throw new Error('empty invented ' + JSON.stringify(quiet))
console.log('load=' + v.load1)
console.log('mem=' + v.memPct)
console.log('disks=' + v.disks.map((d) => d.mount + ':' + d.usedPct).join(','))
console.log('uptime=' + v.uptime)
"""
        run = _node(script)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("disks=/:11,/mnt/sdb:88", run.stdout)
        self.assertIn("uptime=1d 1h", run.stdout)
        print(run.stdout, end="")

    def test_host_history_series_skips_missing_rates(self):
        host = (ROOT / "frontend/src/routes/infra/host.tsx").read_text()
        self.assertIn("hostHistorySeries", host)
        self.assertIn("bytesRate(vitals.netRx)", host)
        script = """
import { hostHistorySeries } from './frontend/src/lib/hostCharts.ts'
const rows = hostHistorySeries([
  { data: { cpu: { usage_pct: 10 }, memory: { usage_pct: 40 }, network: { rx_bytes_per_sec: 100, tx_bytes_per_sec: 50 }, disk_io: { read_bytes_per_sec: 8, write_bytes_per_sec: 4 } } },
  { data: { cpu: { usage_pct: 12 }, memory: { usage_pct: null }, network: { rx_bytes_per_sec: null, tx_bytes_per_sec: 70 }, disk_io: { read_bytes_per_sec: null, write_bytes_per_sec: null } } },
  { data: { cpu: { usage_pct: 14 }, memory: { usage_pct: 55 }, network: { rx_bytes_per_sec: 300, tx_bytes_per_sec: 80 }, disk_io: {} } },
])
if (rows.host_cpu.join(',') !== '10,12,14') throw new Error('cpu ' + rows.host_cpu.join(','))
if (rows.host_mem.join(',') !== '40,55') throw new Error('mem ' + rows.host_mem.join(','))
if (rows.network.rx_bytes_per_sec.join(',') !== '100,300') throw new Error('rx ' + rows.network.rx_bytes_per_sec.join(','))
if (rows.disk.read_bytes_per_sec.join(',') !== '8') throw new Error('disk ' + rows.disk.read_bytes_per_sec.join(','))
const quiet = hostHistorySeries([{ data: { network: {}, disk_io: {}, disks: [{ read_rate_bytes_sec: null, write_rate_bytes_sec: null }] } }])
if (quiet.network.rx_bytes_per_sec.length || quiet.disk.read_bytes_per_sec.length) throw new Error('invented zero series')
console.log('cpu=' + rows.host_cpu.join(','))
console.log('rx=' + rows.network.rx_bytes_per_sec.join(','))
console.log('disk=' + rows.disk.read_bytes_per_sec.join(','))
"""
        run = _node(script)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("rx=100,300", run.stdout)
        self.assertIn("disk=8", run.stdout)
        print(run.stdout, end="")


if __name__ == "__main__":
    unittest.main()
