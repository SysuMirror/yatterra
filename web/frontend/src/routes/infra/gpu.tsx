import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import InfraNav from '@/components/infra/InfraNav'
import { archLabel, fleetCards } from '@/lib/fleetMachines'
import { acceleratorSeries, attributionForCard, type PodReport } from '@/lib/acceleratorSeries'
import { Select } from '@/components/ui/Select'
import { Monitor, Thermometer, Zap, Box, Activity, MemoryStick, AlertTriangle } from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, YAxis, Tooltip,
} from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { GpuPodDonut } from '@/components/domain/GpuPodDonut'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { api } from '@/api/client'
import { useThemeStore } from '@/stores/theme'
import { seriesColor, chartTooltip, axisTick } from '@/lib/chartColors'
import { formatBytes } from '@/lib/format'

function toRows(series: number[] = []) {
  return series.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }))
}

function memTick(value: number) {
  if (!Number.isFinite(value)) return ''
  if (value >= 1024) {
    const gb = value / 1024
    return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)}G`
  }
  return String(Math.round(value))
}

function finiteBytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Device VRAM, or the host meminfo pool when the card memory is unified and unreported. */
function cardMemory(card: { hostId: string; unified: boolean; memUsedMiB: number | null; memTotalMiB: number | null }, hosts: any[]): { used: number; total: number } | null {
  if (card.memTotalMiB != null) return { used: card.memUsedMiB ?? 0, total: card.memTotalMiB }
  if (!card.unified) return null
  const host = hosts.find((item) => item?.id === card.hostId)
  const total = finiteBytes(host?.data?.memory?.total_bytes)
  if (total == null) return null
  const used = finiteBytes(host?.data?.memory?.used_bytes) ?? 0
  return { used: used / 1024 / 1024, total: total / 1024 / 1024 }
}

function plotSeries(series: number[] | null | undefined, fallback: number): number[] {
  if (series && series.length > 1) return series
  const value = Number.isFinite(fallback) ? fallback : 0
  return [value, value]
}

export default function InfraGpu() {
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const [params, setParams] = useSearchParams()
  const hostFilter = params.get('host') || ''
  const [focus, setFocus] = useState<string | null>(null)
  const [hotFirst, setHotFirst] = useState(true)

  // 跟随主题的 recharts tooltip / 坐标轴样式（与全站图表同一来源）
  const tooltipStyle = chartTooltip(dark)
  const tickFill = axisTick(dark)
  // util 恒为序列 0、mem 恒为序列 1 —— 与其它页同一颜色语义
  const utilColor = seriesColor(dark, 0)
  const memColor = seriesColor(dark, 1)

  const { data: fleetData, isLoading: gpuLoading, error: gpuError, refetch: refetchGpu } = useQuery<any>({
    queryKey: ['infra-fleet'],
    queryFn: () => api.get('/infra/fleet'),
    refetchInterval: 30_000,
  })
  const { data: localGpu } = useQuery<any>({
    queryKey: ['infra-gpu'],
    queryFn: () => api.get('/infra/gpu'),
    staleTime: 10_000,
  })

  const hosts = fleetData?.hosts ?? []
  const histories = useQuery<any[]>({
    queryKey: ['infra-fleet-gpu-history', hosts.map((host: any) => host.id).join('|')],
    enabled: hosts.length > 0,
    staleTime: 30_000,
    queryFn: () => Promise.all(hosts.map(async (host: any) => {
      try {
        const body = await api.get<any>(`/infra/fleet/${encodeURIComponent(host.id)}/history?range=1h`)
        return { id: host.id, samples: body?.samples ?? [] }
      } catch {
        return { id: host.id, samples: [] }
      }
    })),
  })

  const cards = useMemo(() => {
    return fleetCards(fleetData?.hosts ?? []).filter((card) => !hostFilter || card.hostId === hostFilter)
  }, [fleetData, hostFilter])
  const orderedGpus = useMemo(() => {
    const list = cards.filter((card) => !card.empty)
    if (hotFirst) list.sort((a, b) => (b.util ?? -1) - (a.util ?? -1) || (b.temp ?? 0) - (a.temp ?? 0) || a.hostName.localeCompare(b.hostName) || (a.index ?? 0) - (b.index ?? 0))
    else list.sort((a, b) => a.hostName.localeCompare(b.hostName) || (a.index ?? 0) - (b.index ?? 0))
    return list
  }, [cards, hotFirst])
  const accelerators = orderedGpus
  const shownGpus = focus == null ? orderedGpus : orderedGpus.filter((card) => card.cardKey === focus)
  const hostGroups = useMemo(() => {
    const order: string[] = []
    const grouped = new Map<string, typeof shownGpus>()
    for (const card of shownGpus) {
      if (!grouped.has(card.hostId)) {
        order.push(card.hostId)
        grouped.set(card.hostId, [])
      }
      grouped.get(card.hostId)!.push(card)
    }
    return order.map((id) => ({ id, cards: grouped.get(id)! }))
  }, [shownGpus])
  const driverLabels = [...new Set(accelerators.map((card) => card.driver).filter((item): item is string => !!item))]
  const driver = driverLabels.length ? driverLabels.join(' · ') : '未上报'
  const podReports = useMemo<PodReport[]>(() => {
    const reports: PodReport[] = []
    for (const host of hosts) {
      for (const gpu of host?.data?.gpus ?? []) {
        if (!Array.isArray(gpu?.pods) && !Array.isArray(gpu?.groups)) continue
        reports.push({ hostId: host.id, index: gpu.index ?? null, pods: gpu.pods, groups: gpu.groups })
      }
    }
    for (const gpu of localGpu?.gpus ?? []) {
      reports.push({ hostId: 'local', index: gpu.index ?? null, pods: gpu.pods, groups: gpu.groups })
    }
    return reports
  }, [hosts, localGpu])

  const totalGpu = accelerators.length
  const avgUtil = totalGpu > 0 ? accelerators.reduce((sum, card) => sum + (card.util ?? 0), 0) / totalGpu : 0
  const memoryRows = accelerators.map((card) => cardMemory(card, hosts)).filter((row): row is { used: number; total: number } => row != null)
  const totalMemUsed = memoryRows.reduce((sum, row) => sum + row.used, 0)
  const totalMemTotal = memoryRows.reduce((sum, row) => sum + row.total, 0)
  const temps = accelerators.map((card) => card.temp).filter((temp): temp is number => temp != null)
  const maxTemp = temps.length ? Math.max(...temps) : 0

  const aiContext = accelerators.length > 0
    ? `加速器 ${totalGpu} 块，覆盖 ${new Set(accelerators.map((card) => card.hostName)).size} 台机器, 平均利用率: ${avgUtil.toFixed(1)}%, 显存: ${totalMemUsed.toFixed(0)}/${totalMemTotal.toFixed(0)} MiB, 最高温度: ${maxTemp}°C\n` +
      accelerators.map((card) => `${card.hostName} ${archLabel(card.arch)} GPU ${card.index}: ${card.name}, 利用率 ${card.util ?? '—'}%, 温度 ${card.temp ?? '—'}°C`).join('\n')
    : '集群里没有上报加速器'

  return (
    <>
      <InfraNav />
      <PageHeader title="加速器" description={`全部机器 · 驱动 ${driver} · ${totalGpu} 块`} doc={{ section: 'infra', item: 0, label: 'GPU 文档' }}>
        <PageAiAssistant page="gpu" context={aiContext} />
      </PageHeader>

      {/* AI Insight */}
      {!gpuLoading && accelerators.length > 0 && (
        <div data-onboarding-target="gpu-insight" className="mb-5">
          <AiInsightPanel page="gpu" context={aiContext} title="GPU 资源洞察" />
        </div>
      )}

      {/* Error state */}
      {gpuError && (
        <Card data-onboarding-target="gpu-error" padding="lg" className="mb-6">
          <div className="flex items-center gap-3 flex-wrap">
            <AlertTriangle size={16} className="text-bad flex-shrink-0" />
            <span className="text-sm text-bad font-medium">GPU 数据加载失败：{(gpuError as any)?.message || '网络异常'}</span>
            <Button variant="secondary" size="sm" className="ml-auto" onClick={() => refetchGpu()}>重试</Button>
          </div>
        </Card>
      )}

      {/* Overview metric cards */}
      <div data-onboarding-target="gpu-stats" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {gpuLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<Monitor size={15} className="text-warn" />} label="GPU 总数" value={totalGpu} suffix="块" />
            <MetricCard icon={<Activity size={15} className="text-accent" />} label="平均利用率" value={avgUtil.toFixed(1)} suffix="%" percent={avgUtil} />
            <MetricCard icon={<MemoryStick size={15} className="text-ok" />} label="总显存" value={memoryRows.length ? formatBytes(totalMemUsed * 1024 * 1024) : '—'} suffix={memoryRows.length ? `/ ${formatBytes(totalMemTotal * 1024 * 1024)}` : undefined} />
            <MetricCard icon={<Thermometer size={15} className={maxTemp > 80 ? 'text-bad' : maxTemp > 65 ? 'text-warn' : 'text-ok'} />} label="最高温度" value={maxTemp} suffix="°C" />
          </>
        )}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div data-ux="ux-gpu-phone-pick">
          <Select
            label="机器"
            value={hostFilter}
            placeholder="全部机器"
            options={[{ value: '', label: '全部机器' }, ...hosts.map((host: any) => ({ value: host.id, label: `${host.name || host.id} · ${archLabel(host.hardware?.arch)} · ${host.accelerator_count ?? 0} 块` }))]}
            onChange={(value) => { setFocus(null); setParams(value ? { host: value } : {}, { replace: true }) }}
          />
        </div>
        <div data-ux="ux-gpu-focus">
          <Select
            label="卡片"
            value={focus ?? ''}
            placeholder="全部卡片"
            options={[{ value: '', label: '全部卡片' }, ...cards.filter((card) => !card.empty).map((card) => ({ value: card.cardKey, label: `${card.hostName} #${card.index} ${card.name}` }))]}
            onChange={(value) => setFocus(value || null)}
          />
        </div>
        <div data-ux="ux-gpu-hot-sort">
          <Select
            label="排序"
            value={hotFirst ? 'hot' : 'index'}
            options={[{ value: 'hot', label: '最热优先' }, { value: 'index', label: '按序号' }]}
            onChange={(value) => setHotFirst(value !== 'index')}
          />
        </div>
      </div>

      {/* Per-host accelerator cards */}
      <div data-onboarding-target="gpu-cards" className="mb-6 space-y-6">
        {hostGroups.map((group) => (
        <section key={group.id}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <Link to={`/infra/host?machine=${encodeURIComponent(group.id)}`} className="text-sm font-semibold hover:underline">{group.cards[0]?.hostName}</Link>
            <span className="text-xs text-muted">{archLabel(group.cards[0]?.arch)}{group.cards[0]?.cpuModel ? ` · ${group.cards[0].cpuModel}` : ''} · 驱动 {group.cards.find((card) => card.driver)?.driver || '未上报'} · {group.cards.length} 块</span>
          </div>
          <div className={focus == null ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
        {group.cards.map((gpu) => {
          const pool = cardMemory(gpu, hosts)
          const memUsed = pool?.used ?? null
          const memTotal = pool?.total ?? null
          const memPct = memUsed != null && memTotal ? (memUsed / memTotal) * 100 : 0
          const attribution = attributionForCard(gpu, podReports)
          const assignedGroups = attribution.groups
          const namedPods = (attribution.pods ?? []).filter((pod) => pod.mem > 0)
          const namedSum = namedPods.reduce((sum, pod) => sum + pod.mem, 0)
          const hostRow = hosts.find((host: any) => host.id === gpu.hostId)
          const ramBytes = finiteBytes(hostRow?.data?.memory?.total_bytes)
          const hostSamples = (histories.data ?? []).find((row) => row.id === gpu.hostId)?.samples ?? []
          // Discrete cards use nvidia-smi bytes. Unified cards (GB10) report N/A there;
          // the pool is host meminfo, already sampled on every history point.
          const series = acceleratorSeries(hostSamples, {
            index: gpu.index,
            memTotalBytes: gpu.memTotalMiB != null ? gpu.memTotalMiB * 1024 * 1024 : gpu.unified && ramBytes != null ? ramBytes : null,
            memSource: gpu.unified && gpu.memTotalMiB == null ? 'host' : 'device',
          })
          const utilPlot = plotSeries(series.util, gpu.util ?? 0)
          const memPlot = plotSeries(series.mem, memUsed ?? 0)
          const chartId = gpu.cardKey.replace(/[^a-zA-Z0-9_-]/g, '_')
          const donutUsed = memUsed ?? namedSum
          const donutTotal = memTotal ?? namedSum

          return (
            <Card key={gpu.cardKey} padding="lg">
              {/* Header */}
              <div className="flex items-start justify-between gap-2 mb-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  <Monitor size={16} className="text-warn shrink-0" />
                  <Link to={`/infra/host?machine=${encodeURIComponent(gpu.hostId)}`} className="text-sm font-semibold hover:underline">{gpu.hostName}</Link>
                  <span className="text-xs text-muted break-words">{archLabel(gpu.arch)} · #{gpu.index} {gpu.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={gpu.temp != null && gpu.temp > 80 ? 'bad' : gpu.temp != null && gpu.temp > 65 ? 'warn' : 'ok'} className="text-[10px]">
                    <Thermometer size={10} className="mr-0.5" /> {gpu.temp == null ? '—' : `${gpu.temp}°C`}
                  </Badge>
                  {gpu.power != null && (
                    <Badge variant="muted" className="text-[10px]">
                      <Zap size={10} className="mr-0.5" /> {gpu.power}W / {gpu.powerLimit ?? '—'}W
                    </Badge>
                  )}
                </div>
              </div>

              {/* Utilization + Memory bars */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted">利用率</span>
                    <span className="font-medium">{(gpu.util ?? 0).toFixed(0)}%</span>
                  </div>
                  <Progress value={gpu.util ?? 0} size="sm" color={(gpu.util ?? 0) > 90 ? 'bad' : (gpu.util ?? 0) > 70 ? 'warn' : 'accent'} />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted">显存</span>
                    <span className="font-medium">{memTotal == null ? '未上报' : `${formatBytes((memUsed ?? 0) * 1024 * 1024)} / ${formatBytes(memTotal * 1024 * 1024)}`}</span>
                  </div>
                  <Progress value={memPct} size="sm" color={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'accent'} />
                </div>
              </div>

              {/* Both charts stay on every card, including a flat line when history is missing. */}
              <div data-onboarding-target="gpu-trend" className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                      <p className="text-[11px] text-muted mb-1">利用率趋势</p>
                      <div className="h-16">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={toRows(utilPlot)} margin={{ top: 2, right: 4, bottom: 0, left: -14 }}>
                            <defs>
                              <linearGradient id={`gpu-util-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={utilColor} stopOpacity={0.12} />
                                <stop offset="100%" stopColor={utilColor} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: tickFill }} tickLine={false} axisLine={false} width={28} />
                            <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, '利用率']} />
                            <Area type="monotone" dataKey="v" stroke={utilColor} strokeWidth={1.2} fill={`url(#gpu-util-${chartId})`} dot={false} isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted mb-1">显存趋势</p>
                      <div className="h-16">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={toRows(memPlot)} margin={{ top: 2, right: 4, bottom: 0, left: -14 }}>
                            <defs>
                              <linearGradient id={`gpu-mem-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={memColor} stopOpacity={0.12} />
                                <stop offset="100%" stopColor={memColor} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <YAxis domain={[0, Math.max(1, Math.ceil(Math.max(...memPlot) * 1.15))]} tick={{ fontSize: 9, fill: tickFill }} tickFormatter={memTick} tickLine={false} axisLine={false} width={32} />
                            <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(0)} MB`, '显存']} />
                            <Area type="monotone" dataKey="v" stroke={memColor} strokeWidth={1.2} fill={`url(#gpu-mem-${chartId})`} dot={false} isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
              </div>

              {/* Live per-Pod VRAM. Always rendered so an idle card keeps the
                  same layout and shows the empty state instead of no block. */}
              <div className="mb-4">
                <GpuPodDonut gpu={{ index: gpu.index ?? 0, mem_used: donutUsed, mem_total: donutTotal, pods: namedPods }} />
              </div>
              {namedPods.length === 0 && gpu.memUsedMiB != null && gpu.memUsedMiB > 256 && (
                <p className="mb-4 text-xs text-muted">这块卡的显存没有对应到 Pod</p>
              )}

              {/* Assigned pods */}
              {assignedGroups && assignedGroups.length > 0 && (
                <div data-onboarding-target="gpu-assigned">
                  <p className="text-[11px] text-muted mb-1.5">已分配 Pod</p>
                  <div className="flex flex-wrap gap-1.5">
                    {assignedGroups.map((name: string) => (
                      <Badge key={name} variant="accent" className="text-[10px]">
                        <Box size={9} className="mr-0.5" /> {name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {assignedGroups && assignedGroups.length === 0 && (
                <p className="text-xs text-muted">无 Pod 占用</p>
              )}
            </Card>
          )
        })}
          </div>
        </section>
        ))}
      </div>

      {/* No GPU fallback */}
      {!gpuLoading && !gpuError && accelerators.length === 0 && (
        <Card padding="lg" className="text-center">
          <Monitor size={32} className="mx-auto text-muted/40 mb-2" />
          <p data-ux="ux-gpu-empty-who" className="text-sm text-muted">这些机器没有上报加速器：{(hostFilter ? hosts.filter((host: any) => host.id === hostFilter) : hosts.filter((host: any) => !(host.accelerator_count > 0))).map((host: any) => host.name || host.id).join('、') || '当前没有机器采样'}</p>
        </Card>
      )}
    </>
  )
}
