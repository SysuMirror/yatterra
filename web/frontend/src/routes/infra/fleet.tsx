import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Server, WifiOff } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Progress } from '@/components/ui/Progress'
import { api } from '@/api/client'
import InfraNav from '@/components/infra/InfraNav'
import { archLabel } from '@/lib/fleetMachines'
import { useThemeStore } from '@/stores/theme'
import { piePalette, chartTooltip } from '@/lib/chartColors'
import { formatBytes } from '@/lib/format'

const ranges = ['15m', '1h', '6h', '24h', '7d'] as const
const num = (v: any) => typeof v === 'number' && Number.isFinite(v) ? v : null
const dataOf = (s: any) => s?.data ?? {}
const bucketOf = (ts: any) => Math.floor(Number(ts || 0) / 60) * 60
const bytesToGiB = (v: any) => num(v) == null ? null : Number(v) / (1024 ** 3)
const fmt = (v: any, u = '') => num(v) == null ? '—' : `${Number(v).toFixed(1)}${u}`

function disksOf(data: any): any[] {
  if (Array.isArray(data?.disks)) return data.disks
  if (Array.isArray(data?.disk)) return data.disk
  return []
}

function diskPct(disk: any) {
  return num(disk?.usage_pct ?? disk?.used_pct)
}

function diskUsed(disk: any) {
  if (disk?.used_h) return disk.used_h
  return num(disk?.used_bytes) == null ? '—' : formatBytes(disk.used_bytes)
}

function diskTotal(disk: any) {
  if (disk?.total_h) return disk.total_h
  return num(disk?.total_bytes) == null ? '—' : formatBytes(disk.total_bytes)
}

function DiskRows({ data }: { data: any }) {
  const disks = disksOf(data)
  if (!disks.length) return <p className="mt-3 text-xs text-muted">无磁盘数据</p>
  return (
    <div className="mt-3 space-y-2">
      {disks.map((disk, i) => {
        const pct = diskPct(disk)
        const color = pct != null && pct > 90 ? 'bad' : pct != null && pct > 70 ? 'warn' : 'ok'
        return (
          <div key={`${disk.mount}-${i}`}>
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span className="font-mono truncate">{disk.mount}</span>
              <span className="tnum shrink-0">
                {disk.error ? disk.error : `${diskUsed(disk)} / ${diskTotal(disk)}${pct == null ? '' : ` · ${Math.round(pct)}%`}`}
              </span>
            </div>
            {disk.error || pct == null ? null : <Progress value={pct} size="sm" color={color} />}
          </div>
        )
      })}
    </div>
  )
}

function Chart({ title, rows, keys, unit = '' }: any) {
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const colors = piePalette(dark)
  return (
    <Card padding="md">
      <div className="flex flex-wrap justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex flex-wrap gap-3 text-xs text-muted">
          {keys.map((k: string, i: number) => (
            <span key={k}><i className="inline-block h-2 w-2 rounded-full mr-1" style={{ background: colors[i % colors.length] }} />{k}</span>
          ))}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={rows}>
            <CartesianGrid stroke="var(--border-subtle,#e5e7eb)" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip {...chartTooltip(dark)} formatter={(v: any, n: any) => [v == null ? '—' : `${Number(v).toFixed(1)}${unit}`, n]} />
            {keys.map((k: string, i: number) => (
              <Line key={k} dataKey={k} name={k} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} connectNulls={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

export default function FleetPage() {
  const [range, setRange] = useState<(typeof ranges)[number]>('15m')
  const fleet = useQuery<any>({ queryKey: ['infra-fleet'], queryFn: () => api.get('/infra/fleet'), refetchInterval: 30000 })
  const hosts = fleet.data?.hosts ?? []
  const histories = useQuery<any[]>({
    queryKey: ['fleet-history', range, hosts.map((h: any) => h.id)],
    enabled: hosts.length > 0,
    queryFn: () => Promise.all(hosts.map(async (h: any) => ({ id: h.id, ...await api.get<any>(`/infra/fleet/${encodeURIComponent(h.id)}/history?range=${range}`) }))),
  })
  const hostIds = hosts.map((h: any) => h.id)
  const metricRows = (metric: string) => {
    const map = new Map<number, any>()
    ;(histories.data ?? []).forEach((h: any) => h.samples?.forEach((s: any) => {
      const d = dataOf(s)
      const bucket = bucketOf(s.timestamp)
      const row = map.get(bucket) ?? { ts: bucket, label: new Date(bucket * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
      row[h.id] = num(metric === 'cpu' ? d.cpu?.usage_pct : metric === 'memory' ? d.memory?.usage_pct : d.cpu?.load1)
      map.set(bucket, row)
    }))
    return [...map.values()].sort((a, b) => a.ts - b.ts)
  }
  const gpuBlock = (hostId: string) => {
    const samples = (histories.data ?? []).find((h: any) => h.id === hostId)?.samples ?? []
    const gpuIds = [...new Set<string>(samples.flatMap((s: any) => (dataOf(s).gpus ?? []).map((g: any) => String(g.id ?? g.index))))]
    const gpuRows = (key: string) => samples.map((s: any) => {
      const row: any = { label: new Date((s.timestamp || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
      ;(dataOf(s).gpus ?? []).forEach((g: any) => {
        const id = String(g.id ?? g.index)
        row[id] = key === 'memory_used_bytes' ? bytesToGiB(g[key]) : num(g[key])
      })
      return row
    })
    return { samples, gpuIds, gpuRows }
  }
  const aiContext = hosts.map((h: any) => {
    const d = dataOf(h)
    const disks = disksOf(d).map((disk) => disk.error ? `${disk.mount} ${disk.error}` : `${disk.mount} ${fmt(diskPct(disk), '%')}`).join(', ')
    return `${h.name || h.id}: 状态 ${h.status || 'unknown'}, CPU ${fmt(d.cpu?.usage_pct, '%')}, 内存 ${fmt(d.memory?.usage_pct, '%')}, 负载 ${fmt(d.cpu?.load1)}, 磁盘 ${disks || '无'}`
  }).join('\n')
  if (fleet.isLoading) return <><InfraNav /><PageHeader title="机器对比" /><Skeleton height={180} /></>
  if (fleet.isError) return (
    <>
      <InfraNav />
      <PageHeader title="机器对比" />
      <Card padding="lg">
        <div className="flex items-center gap-3 flex-wrap">
          <AlertTriangle size={16} className="text-bad flex-shrink-0" />
          <span className="text-sm text-bad font-medium">集群数据加载失败</span>
          <Button data-ux="ux-fleet-retry" variant="secondary" size="sm" className="ml-auto" onClick={() => fleet.refetch()}>重试</Button>
        </div>
      </Card>
    </>
  )
  return (
    <>
      <InfraNav />
      <PageHeader title="机器对比" description={`${hosts.length} 台机器的曲线`} doc={{ section: 'infra', item: 0, label: '集群文档' }} actions={
        <>
          <PageAiAssistant page="fleet" context={aiContext} />
        </>
      } />
      {aiContext && <div data-onboarding-target="fleet-insight" className="mb-5"><AiInsightPanel page="fleet" context={aiContext} title="集群健康洞察" /></div>}
      {!hosts.length ? (
        <Card padding="lg">
          <EmptyState icon={<Server size={20} />} title="暂无节点数据" description="集群节点上报后这里会显示机器对比。" />
        </Card>
      ) : (
        <>
          <div data-onboarding-target="fleet-hosts" className="mb-5 space-y-4">
            {hosts.map((active: any) => (
              <Card key={active.id}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <b className="text-sm">{active.name || active.id}</b>
                  <Badge variant={active.status === 'online' && !active.stale ? 'ok' : active.status === 'offline' ? 'bad' : 'warn'} dot>{active.status || '未知'}</Badge>
                </div>
                <p className="mb-2 text-xs text-muted">{archLabel(active.hardware?.arch)} · {active.hardware?.cpu_model || '处理器未上报'} · {active.hardware?.product || '机型未上报'}</p>
                <p className="mb-2 text-xs">{(dataOf(active).gpus ?? []).map((gpu: any) => gpu.name).filter(Boolean).join('、') || '无加速器'}</p>
                <div className="mb-2 flex flex-wrap gap-3 text-xs">
                  <Link className="text-accent" to={`/infra/host?machine=${encodeURIComponent(active.id)}`}>打开这台机器</Link>
                  <Link className="text-accent" to={`/infra/gpu?host=${encodeURIComponent(active.id)}`}>打开加速器</Link>
                </div>
                <div className="grid grid-cols-3 text-xs text-muted">
                  <span>CPU {fmt(dataOf(active).cpu?.usage_pct, '%')}</span>
                  <span>内存 {fmt(dataOf(active).memory?.usage_pct, '%')}</span>
                  <span>负载 {fmt(dataOf(active).cpu?.load1)}</span>
                </div>
                <DiskRows data={dataOf(active)} />
              </Card>
            ))}
          </div>
          <div data-onboarding-target="fleet-charts" className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-5">
            <Chart title="CPU 使用率" rows={metricRows('cpu')} keys={hostIds} unit="%" />
            <Chart title="内存使用率" rows={metricRows('memory')} keys={hostIds} unit="%" />
            <Chart title="系统负载" rows={metricRows('load')} keys={hostIds} />
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {ranges.map(r => (
              <button data-onboarding-target="fleet-range" type="button" key={r} aria-pressed={range === r} onClick={() => setRange(r)} className={`px-2 py-1 text-xs rounded focus-visible:outline focus-visible:outline-2 ${range === r ? 'bg-accent/85 glass-blur text-white' : 'bg-black/5'}`}>{r}</button>
            ))}
          </div>
          {histories.isError ? <Card><WifiOff size={16} className="inline mr-2 text-bad" />历史数据加载失败</Card> : hosts.map((host: any) => {
            const block = gpuBlock(host.id)
            if (!block.samples.length) return <Card key={host.id} className="mb-4"><span className="text-sm text-muted">{host.name || host.id} 该范围暂无历史数据</span></Card>
            return (
              <div key={host.id} className="mb-6">
                <b className="mb-3 block text-sm">{host.name || host.id} 加速器曲线</b>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <Chart title="GPU 利用率" rows={block.gpuRows('utilization_pct')} keys={block.gpuIds} unit="%" />
                  <Chart title="GPU 显存使用" rows={block.gpuRows('memory_used_bytes')} keys={block.gpuIds} unit=" GiB" />
                  <Chart title="GPU 温度" rows={block.gpuRows('temperature_c')} keys={block.gpuIds} unit="°C" />
                </div>
              </div>
            )
          })}
        </>
      )}
    </>
  )
}
