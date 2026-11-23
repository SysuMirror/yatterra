import { useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { Cpu, HardDrive, MemoryStick, Sparkles, Loader2, Network } from 'lucide-react'
import { hostChartMarks, type MarkIcon } from '@/lib/hostCharts'
import { aiApi } from '@/api/ai'
import { MarkdownContent } from '@/components/ai'
import { useThemeStore } from '@/stores/theme'
import { seriesColor, chartTooltip, axisTick, gridStroke } from '@/lib/chartColors'

/** Convert a number[] time series to recharts-friendly rows */
function toRows(series: number[] = []): { i: number; v: number }[] {
  return series.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }))
}

/** Latest value from a series */
function latest(series: number[] = []): number {
  return series.length ? (series[series.length - 1] ?? 0) : 0
}

/** Mean of a series */
function mean(series: number[] = []): number {
  if (!series.length) return 0
  return series.reduce((a, b) => a + b, 0) / series.length
}

// ── Types ──

interface GpuSeries {
  mem: number[]
  util: number[]
}

interface GroupSeries {
  cpu: number[]
  mem: number[]
}

interface NetworkSeries {
  rx_bytes_per_sec?: number[]
  tx_bytes_per_sec?: number[]
  rx_packets_per_sec?: number[]
  tx_packets_per_sec?: number[]
  rx_dropped_per_sec?: number[]
  tx_dropped_per_sec?: number[]
  rx_drop_pct?: number[]
  tx_drop_pct?: number[]
}

interface DiskSeries {
  read_bytes_per_sec?: number[]
  write_bytes_per_sec?: number[]
  read_ops_per_sec?: number[]
  write_ops_per_sec?: number[]
  await_ms?: number[]
  busy_pct?: number[]
  queue_depth?: number[]
}

export interface ClusterMetricsData {
  gpus?: Record<string, GpuSeries>
  groups?: Record<string, GroupSeries>
  host_cpu?: number[]
  host_mem?: number[]
  network?: NetworkSeries
  disk?: DiskSeries
  samples?: number
}

interface Props {
  data: ClusterMetricsData
}

// ── Component ──

export function ClusterMetrics({ data }: Props) {
  const { gpus, groups, host_cpu, host_mem, network, disk } = data
  const hostMarks = hostChartMarks(host_cpu ?? [], host_mem ?? [])
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const [aiAnalysis, setAiAnalysis] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAnalyze = async () => {
    setAiLoading(true)
    setAiAnalysis('')
    try {
      const parts: string[] = []
      if (host_cpu?.length) parts.push(`主机CPU: 平均 ${mean(host_cpu).toFixed(1)}%, 峰值 ${Math.max(...host_cpu).toFixed(1)}%`)
      if (host_mem?.length) parts.push(`主机内存: 平均 ${mean(host_mem).toFixed(1)}%, 峰值 ${Math.max(...host_mem).toFixed(1)}%`)
      if (network?.rx_bytes_per_sec?.length) parts.push(`网络下行: 最新 ${formatBytesRate(latest(network.rx_bytes_per_sec))}, 上行 ${formatBytesRate(latest(network.tx_bytes_per_sec ?? []))}`)
      if (disk?.read_bytes_per_sec?.length) parts.push(`磁盘读写: 读 ${formatBytesRate(latest(disk.read_bytes_per_sec))}, 写 ${formatBytesRate(latest(disk.write_bytes_per_sec ?? []))}, await ${latest(disk.await_ms ?? []).toFixed(1)}ms`)
      if (gpus) for (const [k, v] of Object.entries(gpus)) parts.push(`GPU ${k}: 利用率平均 ${mean(v.util).toFixed(1)}%, 显存平均 ${mean(v.mem).toFixed(1)}%`)
      if (groups) for (const [k, v] of Object.entries(groups)) parts.push(`组 ${k}: CPU平均 ${mean(v.cpu).toFixed(1)}%, 内存平均 ${mean(v.mem).toFixed(1)}%`)
      const res = await aiApi.analyze({ text: parts.join('\n'), task: 'explain' })
      setAiAnalysis(res.content)
    } catch {
      setAiAnalysis('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <button
          onClick={handleAiAnalyze}
          disabled={aiLoading}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
        >
          {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {aiLoading ? '分析中...' : 'AI 分析集群资源'}
        </button>
      </div>
      {aiAnalysis && (
        <div className="p-3 rounded-lg bg-accent/5 border border-accent/10">
          <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 分析</div>
          <MarkdownContent content={aiAnalysis} />
        </div>
      )}
      {/* Host CPU + Mem */}
      {(host_cpu?.length ?? 0) > 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TimeSeriesCard
            title={hostMarks.cpu.label}
            icon={markIcon(hostMarks.cpu.icon, 'text-accent')}
            series={hostMarks.cpu.series}
            color={seriesColor(dark, 0)}
            unit="%"
            yDomain={[0, Math.max(100, ...hostMarks.cpu.series, 0) * 1.2]}
          />
          <TimeSeriesCard
            title={hostMarks.memory.label}
            icon={markIcon(hostMarks.memory.icon, 'text-ok')}
            series={hostMarks.memory.series}
            color={seriesColor(dark, 1)}
            unit="%"
            yDomain={[0, 100]}
          />
        </div>
      )}

      {((network?.rx_bytes_per_sec?.length ?? 0) > 1 || (disk?.read_bytes_per_sec?.length ?? 0) > 1) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(network?.rx_bytes_per_sec?.length ?? 0) > 1 && (
            <DualSeriesCard
              title="网络吞吐"
              icon={<Network size={14} className="text-accent" />}
              a={network?.rx_bytes_per_sec ?? []}
              b={network?.tx_bytes_per_sec ?? []}
              aName="下行"
              bName="上行"
              colorA={seriesColor(dark, 0)}
              colorB={seriesColor(dark, 2)}
              formatter={formatBytesRate}
            />
          )}
          {(disk?.read_bytes_per_sec?.length ?? 0) > 1 && (
            <DualSeriesCard
              title="磁盘 IO"
              icon={<HardDrive size={14} className="text-warn" />}
              a={disk?.read_bytes_per_sec ?? []}
              b={disk?.write_bytes_per_sec ?? []}
              aName="读取"
              bName="写入"
              colorA={seriesColor(dark, 6)}
              colorB={seriesColor(dark, 1)}
              formatter={formatBytesRate}
            />
          )}
          {(network?.rx_packets_per_sec?.length ?? 0) > 1 && (
            <DualSeriesCard
              title="收发数据包"
              icon={<Network size={14} className="text-ok" />}
              a={network?.rx_packets_per_sec ?? []}
              b={network?.tx_packets_per_sec ?? []}
              aName="接收"
              bName="发送"
              colorA={seriesColor(dark, 0)}
              colorB={seriesColor(dark, 2)}
              formatter={(v) => `${formatNumber(v)}/s`}
            />
          )}
          {(disk?.read_ops_per_sec?.length ?? 0) > 1 && (
            <DualSeriesCard
              title="磁盘 IOPS"
              icon={<HardDrive size={14} className="text-accent" />}
              a={disk?.read_ops_per_sec ?? []}
              b={disk?.write_ops_per_sec ?? []}
              aName="读 IOPS"
              bName="写 IOPS"
              colorA={seriesColor(dark, 6)}
              colorB={seriesColor(dark, 1)}
              formatter={(v) => `${formatNumber(v)}/s`}
            />
          )}
        </div>
      )}

      {((network?.rx_drop_pct?.length ?? 0) > 1 || (disk?.await_ms?.length ?? 0) > 1) && (
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-sm font-semibold">异常与延迟</h3>
            <span className="text-xs text-muted ml-auto">丢包按网卡 drop 计数估算</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <Stat label="接收丢包率" value={`${latest(network?.rx_drop_pct ?? []).toFixed(3)}%`} />
            <Stat label="发送丢包率" value={`${latest(network?.tx_drop_pct ?? []).toFixed(3)}%`} />
            <Stat label="磁盘 await" value={`${latest(disk?.await_ms ?? []).toFixed(1)} ms`} />
            <Stat label="磁盘繁忙" value={`${latest(disk?.busy_pct ?? []).toFixed(1)}%`} />
          </div>
        </Card>
      )}

    </div>
  )
}

function markIcon(name: MarkIcon, className: string) {
  if (name === 'cpu') return <Cpu size={14} className={className} />
  if (name === 'memory') return <MemoryStick size={14} className={className} />
  return <HardDrive size={14} className={className} />
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toFixed(value >= 10 ? 0 : 1)
}

function formatBytesRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s'
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s']
  let v = value
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`
}

function pairRows(a: number[] = [], b: number[] = []) {
  const n = Math.max(a.length, b.length)
  return Array.from({ length: n }, (_, i) => ({ i, a: a[i] ?? null, b: b[i] ?? null }))
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-black/[0.02] p-3"><p className="text-xs text-muted mb-1">{label}</p><p className="tnum font-semibold">{value}</p></div>
}

function DualSeriesCard({ title, icon, a, b, aName, bName, colorA, colorB, formatter }: {
  title: string; icon: React.ReactNode; a: number[]; b: number[]; aName: string; bName: string; colorA: string; colorB: string; formatter: (v: number) => string
}) {
  const rows = pairRows(a, b)
  const max = Math.max(1, ...a, ...b)
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">{icon}<span className="text-sm font-semibold">{title}</span></div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span style={{ color: colorA }}>{aName} {formatter(latest(a))}</span>
          <span style={{ color: colorB }}>{bName} {formatter(latest(b))}</span>
        </div>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid stroke={gridStroke(dark)} vertical={false} />
            <XAxis dataKey="i" tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis domain={[0, max * 1.15]} tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} tickFormatter={(v) => formatter(Number(v)).replace('/s', '')} width={52} />
            <Tooltip {...chartTooltip(dark)} formatter={(v: any, name: any) => [formatter(Number(v)), name === 'a' ? aName : bName]} />
            <Line type="monotone" dataKey="a" stroke={colorA} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="b" stroke={colorB} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

// ── Sub-components ──

function TimeSeriesCard({
  title, icon, series, color, unit, yDomain,
}: {
  title: string; icon: React.ReactNode; series: number[]; color: string; unit: string; yDomain: [number, number]
}) {
  const rows = toRows(series)
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <span className="text-xs text-muted">近 {rows.length} 采样点</span>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
            <defs>
              <linearGradient id={`grad-${title}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.15} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={gridStroke(dark)} vertical={false} />
            <XAxis dataKey="i" tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis domain={yDomain} tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} unit={unit} />
            <Tooltip {...chartTooltip(dark)} formatter={(v: any) => [`${Number(v).toFixed(1)}${unit}`, title]} />
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#grad-${title})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
