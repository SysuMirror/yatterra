import { useQuery } from '@tanstack/react-query'
import { Monitor, Thermometer, Zap, Box, Activity, HardDrive, AlertTriangle } from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
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
import { formatBytes } from '@/lib/format'

function toRows(series: number[] = []) {
  return series.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }))
}

export default function InfraGpu() {
  const dark = useThemeStore((s) => s.resolved) === 'dark'

  // 跟随主题的 recharts tooltip / 坐标轴样式
  const tooltipStyle = {
    contentStyle: {
      borderRadius: 10,
      border: dark ? '0.5px solid rgba(255,255,255,0.12)' : '0.5px solid rgba(0,0,0,0.1)',
      fontSize: 12,
      background: dark ? 'rgba(28,28,30,0.95)' : 'rgba(255,255,255,0.95)',
      color: dark ? '#f5f5f7' : undefined,
    },
    labelStyle: { color: dark ? '#98989d' : '#86868b', fontSize: 11 },
  }
  const tickFill = dark ? '#98989d' : '#86868b'

  const { data: gpuData, isLoading: gpuLoading, error: gpuError, refetch: refetchGpu } = useQuery<any>({
    queryKey: ['infra-gpu'],
    queryFn: () => api.get('/infra/gpu'),
    staleTime: 10_000,
  })

  const { data: hostData } = useQuery<any>({
    queryKey: ['infra-host'],
    queryFn: () => api.get('/infra/host'),
    staleTime: 10_000,
  })

  const { data: metricsData } = useQuery<any>({
    queryKey: ['infra-metrics'],
    queryFn: () => api.get('/infra/metrics'),
    staleTime: 10_000,
  })

  const gpus = gpuData?.gpus ?? []
  const driver = hostData?.nvidia?.driver_version ?? '—'
  const gpuSeries = metricsData?.gpus ?? {}

  // Aggregate stats
  const totalGpu = gpus.length
  const avgUtil = totalGpu > 0 ? gpus.reduce((s: number, g: any) => s + (g.util ?? 0), 0) / totalGpu : 0
  const totalMemUsed = gpus.reduce((s: number, g: any) => s + (parseFloat(g.mem_used) || 0), 0)
  const totalMemTotal = gpus.reduce((s: number, g: any) => s + (parseFloat(g.mem_total) || 0), 0)
  const maxTemp = gpus.length > 0 ? Math.max(...gpus.map((g: any) => g.temp ?? 0)) : 0

  const aiContext = gpus.length > 0
    ? `GPU 总数: ${totalGpu}, 平均利用率: ${avgUtil.toFixed(1)}%, 显存: ${totalMemUsed.toFixed(1)}/${totalMemTotal.toFixed(1)} GB, 最高温度: ${maxTemp}°C\n` +
      gpus.map((g: any) => {
        const pods = (g.pods ?? []).map((p: any) => `${p.name} ${(p.mem / 1024).toFixed(1)}GB/利用率${(p.util ?? 0).toFixed(0)}%`).join(', ')
        return `GPU ${g.index ?? '?'}: ${g.name ?? 'unknown'}, 利用率 ${g.util ?? 0}%, 显存 ${g.mem_used ?? 0}/${g.mem_total ?? 0} GB, 温度 ${g.temp ?? 0}°C` + (pods ? `, 按 Pod 实际占用: ${pods}` : '')
      }).join('\n')
    : '暂无 GPU 数据'

  return (
    <>
      <PageHeader title="GPU 监控" description={`驱动 ${driver} · ${totalGpu} 块 GPU`} doc={{ section: 'infra', item: 0, label: 'GPU 文档' }}>
        <PageAiAssistant page="gpu" context={aiContext} />
      </PageHeader>

      {/* AI Insight */}
      {!gpuLoading && gpus.length > 0 && (
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
            <MetricCard icon={<HardDrive size={15} className="text-ok" />} label="总显存" value={formatBytes(totalMemUsed * 1024 * 1024)} suffix={`/ ${formatBytes(totalMemTotal * 1024 * 1024)}`} />
            <MetricCard icon={<Thermometer size={15} className={maxTemp > 80 ? 'text-bad' : maxTemp > 65 ? 'text-warn' : 'text-ok'} />} label="最高温度" value={maxTemp} suffix="°C" />
          </>
        )}
      </div>

      {/* Per-GPU detail cards */}
      <div data-onboarding-target="gpu-cards" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {gpus.map((gpu: any) => {
          const memUsed = parseFloat(gpu.mem_used) || 0
          const memTotal = parseFloat(gpu.mem_total) || 1
          const memPct = (memUsed / memTotal) * 100
          const assignedGroups: string[] = gpu.groups ?? []
          const series = gpuSeries[String(gpu.index)]

          return (
            <Card key={gpu.index} padding="lg">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Monitor size={16} className="text-warn" />
                  <span className="text-sm font-semibold">GPU #{gpu.index}</span>
                  <span className="text-xs text-muted">{gpu.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={gpu.temp > 80 ? 'bad' : gpu.temp > 65 ? 'warn' : 'ok'} className="text-[10px]">
                    <Thermometer size={10} className="mr-0.5" /> {gpu.temp}°C
                  </Badge>
                  {gpu.power != null && (
                    <Badge variant="muted" className="text-[10px]">
                      <Zap size={10} className="mr-0.5" /> {gpu.power}W / {gpu.power_limit}W
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
                    <span className="font-medium">{formatBytes(memUsed * 1024 * 1024)} / {formatBytes(memTotal * 1024 * 1024)}</span>
                  </div>
                  <Progress value={memPct} size="sm" color={memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : 'accent'} />
                </div>
              </div>

              {/* Time series charts */}
              {series && (series.util?.length > 1 || series.mem?.length > 1) && (
                <div data-onboarding-target="gpu-trend" className="grid grid-cols-2 gap-4 mb-4">
                  {series.util?.length > 1 && (
                    <div>
                      <p className="text-[11px] text-muted mb-1">利用率趋势</p>
                      <div className="h-16">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={toRows(series.util)} margin={{ top: 2, right: 4, bottom: 0, left: -14 }}>
                            <defs>
                              <linearGradient id={`gpu-util-${gpu.index}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#0a84ff" stopOpacity={0.12} />
                                <stop offset="100%" stopColor="#0a84ff" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: tickFill }} tickLine={false} axisLine={false} width={28} />
                            <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, '利用率']} />
                            <Area type="monotone" dataKey="v" stroke="#0a84ff" strokeWidth={1.2} fill={`url(#gpu-util-${gpu.index})`} dot={false} isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                  {series.mem?.length > 1 && (
                    <div>
                      <p className="text-[11px] text-muted mb-1">显存趋势</p>
                      <div className="h-16">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={toRows(series.mem)} margin={{ top: 2, right: 4, bottom: 0, left: -14 }}>
                            <defs>
                              <linearGradient id={`gpu-mem-${gpu.index}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#ff9f0a" stopOpacity={0.12} />
                                <stop offset="100%" stopColor="#ff9f0a" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <YAxis domain={[0, Math.max(...series.mem) * 1.15]} tick={{ fontSize: 9, fill: tickFill }} tickLine={false} axisLine={false} width={28} />
                            <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(0)} MB`, '显存']} />
                            <Area type="monotone" dataKey="v" stroke="#ff9f0a" strokeWidth={1.2} fill={`url(#gpu-mem-${gpu.index})`} dot={false} isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Live per-Pod VRAM / utilisation attribution */}
              <div className="mb-4">
                <GpuPodDonut gpu={gpu} />
              </div>

              {/* Assigned pods */}
              {assignedGroups.length > 0 && (
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
              {assignedGroups.length === 0 && (
                <p className="text-xs text-muted">无 Pod 占用</p>
              )}
            </Card>
          )
        })}
      </div>

      {/* No GPU fallback */}
      {!gpuLoading && !gpuError && gpus.length === 0 && (
        <Card padding="lg" className="text-center">
          <Monitor size={32} className="mx-auto text-muted/40 mb-2" />
          <p className="text-sm text-muted">未检测到 GPU 设备</p>
        </Card>
      )}
    </>
  )
}
