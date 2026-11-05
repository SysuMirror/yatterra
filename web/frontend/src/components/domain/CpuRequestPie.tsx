import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Cpu, MemoryStick, Loader2 } from 'lucide-react'
import { useThemeStore } from '@/stores/theme'
import { piePalette, otherColor, chartTooltip } from '@/lib/chartColors'
import { api } from '@/api/client'

// Ring slots == palette length (7): the long tail of pods folds into one neutral
// "其他" slice instead of cycling hues across ~30 pods.
const MAX_SLICES = 7

interface PodReq {
  name: string
  cpu_request: number
  cpu_limit: number
  mem_request_gi: number
  mem_limit_gi: number
  phase: string
}

interface ReqData {
  allocatable_cpu: number
  allocatable_mem_gi: number
  used_cpu: number
  used_mem_gi: number
  pods: PodReq[]
}

type Metric = 'cpu' | 'mem'

// Per-metric view of the shared /infra/cpu-requests payload. Requests are the
// EWMA-derived values stamped into each pod spec (see req_estimate.py), read
// live from k8s so in-place /resize is reflected without a restart.
const CFG: Record<Metric, {
  title: string
  unit: string
  icon: typeof Cpu
  loading: string
  value: (p: PodReq) => number
  limit: (p: PodReq) => number
  total: (d: ReqData) => number
  alloc: (d: ReqData) => number
  fmtValue: (v: number) => string
  fmtLimit: (v: number) => string
  fmtTotal: (v: number) => string
  fmtAlloc: (v: number) => string
}> = {
  cpu: {
    title: 'CPU 预留分布',
    unit: '核',
    icon: Cpu,
    loading: '加载 CPU 预留…',
    value: p => p.cpu_request,
    limit: p => p.cpu_limit,
    total: d => d.used_cpu,
    alloc: d => d.allocatable_cpu,
    fmtValue: v => v.toFixed(2),
    fmtLimit: v => v.toFixed(1),
    fmtTotal: v => v.toFixed(1),
    fmtAlloc: v => v.toFixed(0),
  },
  mem: {
    title: '内存预留分布',
    unit: 'Gi',
    icon: MemoryStick,
    loading: '加载内存预留…',
    value: p => p.mem_request_gi,
    limit: p => p.mem_limit_gi,
    total: d => d.used_mem_gi,
    alloc: d => d.allocatable_mem_gi,
    fmtValue: v => v.toFixed(1),
    fmtLimit: v => v.toFixed(0),
    fmtTotal: v => v.toFixed(1),
    fmtAlloc: v => v.toFixed(0),
  },
}

function ResourceRequestPie({ metric }: { metric: Metric }) {
  const c = CFG[metric]
  const Icon = c.icon
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const colors = piePalette(dark)
  const neutral = otherColor(dark)
  const tooltipStyle = chartTooltip(dark)
  const { data, isLoading } = useQuery<ReqData>({
    queryKey: ['infra-cpu-requests'],
    queryFn: () => api.get('/infra/cpu-requests'),
    staleTime: 15_000,
  })

  if (isLoading) {
    return (
      <Card padding="lg">
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">{c.loading}</span>
        </div>
      </Card>
    )
  }

  if (!data || !data.pods.length) return null

  // only Running/Pending pods consume scheduling requests
  const pods = data.pods.filter(p => p.phase === 'Running' || p.phase === 'Pending')
  // rank by request so the ring's top-N are the pods that actually hold capacity
  const ranked = pods.filter(p => c.value(p) > 0).slice().sort((a, b) => c.value(b) - c.value(a))
  const top = ranked.slice(0, MAX_SLICES)
  const folded = ranked.slice(MAX_SLICES).reduce((s, p) => s + c.value(p), 0)
  const colorOf = new Map(top.map((p, i) => [p.name, colors[i]]))
  const chartData = [
    ...top.map((p, i) => ({ name: p.name, value: c.value(p), limit: c.limit(p), color: colors[i] })),
    ...(folded > 0 ? [{ name: `其他 (${ranked.length - MAX_SLICES} 个)`, value: folded, limit: null, color: neutral }] : []),
  ]
  const totalReq = c.total(data)
  const alloc = c.alloc(data) || 1
  const freePct = Math.max(0, (1 - totalReq / alloc) * 100)
  const usedPct = Math.min(100, totalReq / alloc * 100)

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-4">
        <Icon size={16} className="text-accent" />
        <h3 className="text-sm font-semibold">{c.title}</h3>
        <span className="text-xs text-muted ml-auto">
          {c.fmtTotal(totalReq)} / {c.fmtAlloc(alloc)} {c.unit}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(220px,280px)_1fr] gap-4">
        {/* Donut chart */}
        <div className="relative h-[220px] sm:h-[260px] md:h-[280px] lg:h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius="58%"
                outerRadius="88%"
                paddingAngle={1.5}
                stroke={dark ? '#18222f' : '#ffffff'}
                strokeWidth={2}
                isAnimationActive={false}
              >
                {chartData.map((s, i) => (
                  <Cell key={i} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                {...tooltipStyle}
                formatter={(v: any, _n: any, entry: any) => {
                  const limit = entry?.payload?.limit
                  const tail = limit == null ? '' : ` (limit ${c.fmtLimit(Number(limit))})`
                  return [`${c.fmtValue(Number(v))} ${c.unit}${tail}`, entry?.payload?.name]
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* center label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-xl sm:text-2xl font-semibold tnum">{usedPct.toFixed(0)}%</span>
            <span className="text-[10px] sm:text-[11px] text-muted">已预留</span>
            <span className="text-[10px] sm:text-[11px] text-ok mt-0.5">{freePct.toFixed(0)}% 空闲</span>
          </div>
        </div>

        {/* Legend / table */}
        <div className="max-h-[220px] sm:max-h-[260px] md:max-h-[280px] lg:max-h-[260px] overflow-auto -mx-1 px-1">
          <table className="w-full text-xs min-w-[260px]">
            <thead className="sticky top-0 bg-white/80 backdrop-blur-sm">
              <tr className="border-b border-black/[0.06]">
                <th className="text-left py-1.5 pr-2 text-[10px] text-muted font-medium">Pod</th>
                <th className="text-right py-1.5 px-2 text-[10px] text-muted font-medium">预留</th>
                <th className="text-right py-1.5 px-2 text-[10px] text-muted font-medium">上限</th>
                <th className="py-1.5 pl-2 w-16 text-[10px] text-muted font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {pods.slice().sort((a, b) => c.value(b) - c.value(a)).map((p) => (
                <tr key={p.name} className="border-b border-black/[0.03] last:border-0 hover:bg-black/[0.02]">
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ background: colorOf.get(p.name) ?? neutral }}
                      />
                      <span className="font-mono text-[11px] truncate" title={p.name}>{p.name}</span>
                    </div>
                  </td>
                  <td className="text-right py-1.5 px-2 tnum font-medium">{c.fmtValue(c.value(p))}</td>
                  <td className="text-right py-1.5 px-2 tnum text-muted">{c.fmtLimit(c.limit(p))}</td>
                  <td className="py-1.5 pl-2">
                    <Badge
                      variant={p.phase === 'Running' ? 'ok' : p.phase === 'Pending' ? 'warn' : 'muted'}
                      className="text-[9px]"
                    >
                      {p.phase === 'Running' ? '运行' : p.phase === 'Pending' ? '等待' : p.phase}
                    </Badge>
                  </td>
                </tr>
              ))}
              {folded > 0 && (
                <tr className="border-b border-black/[0.03] last:border-0 bg-black/[0.015]">
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: neutral }} />
                      <span className="text-[11px] text-muted truncate">其他 {ranked.length - MAX_SLICES} 个 Pod</span>
                    </div>
                  </td>
                  <td className="text-right py-1.5 px-2 tnum text-muted">{c.fmtValue(folded)}</td>
                  <td className="text-right py-1.5 px-2 tnum text-muted">—</td>
                  <td className="py-1.5 pl-2" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* footer summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-black/[0.05] text-xs text-muted">
        <span>{pods.length} 个 Pod</span>
        {metric === 'cpu' ? (
          <span>内存预留 {CFG.mem.fmtTotal(data.used_mem_gi)} / {CFG.mem.fmtAlloc(data.allocatable_mem_gi)} Gi</span>
        ) : (
          <span>CPU 预留 {CFG.cpu.fmtTotal(data.used_cpu)} / {CFG.cpu.fmtAlloc(data.allocatable_cpu)} 核</span>
        )}
        <span className="ml-auto">requests 由 EWMA 自动估算 · 原地 /resize 无重启</span>
      </div>
    </Card>
  )
}

export function CpuRequestPie() {
  return <ResourceRequestPie metric="cpu" />
}

export function MemRequestPie() {
  return <ResourceRequestPie metric="mem" />
}
