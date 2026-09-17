import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Cpu, Loader2 } from 'lucide-react'
import { api } from '@/api/client'

const tooltipStyle = {
  contentStyle: { borderRadius: 10, border: '0.5px solid rgba(0,0,0,0.1)', fontSize: 12, background: 'rgba(255,255,255,0.95)' },
  labelStyle: { color: '#86868b', fontSize: 11 },
}

// distinct palette — enough for ~30 pods, cycles if more
const COLORS = [
  '#0a84ff', '#ff9f0a', '#30d158', '#ff375f', '#bf5af2',
  '#64d2ff', '#ffd60a', '#ff6482', '#5e5ce6', '#32ade8',
  '#c45a4a', '#8e8e93', '#34c759', '#ff9500', '#af52de',
  '#00c7be', '#d16935', '#728098', '#98c1d9', '#ee6c4d',
  '#3d5a80', '#98d6ea', '#e0fbfc', '#293241', '#f4a261',
  '#e76f51', '#2a9d8f', '#e9c46a', '#264653', '#fca311',
]

interface PodReq {
  name: string
  cpu_request: number
  cpu_limit: number
  mem_request_gi: number
  mem_limit_gi: number
  phase: string
}

interface CpuReqData {
  allocatable_cpu: number
  allocatable_mem_gi: number
  used_cpu: number
  used_mem_gi: number
  pods: PodReq[]
}

export function CpuRequestPie() {
  const { data, isLoading } = useQuery<CpuReqData>({
    queryKey: ['infra-cpu-requests'],
    queryFn: () => api.get('/infra/cpu-requests'),
    staleTime: 15_000,
  })

  if (isLoading) {
    return (
      <Card padding="lg" className="mb-6">
        <div className="flex items-center gap-2 text-muted">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-sm">加载 CPU 预留…</span>
        </div>
      </Card>
    )
  }

  if (!data || !data.pods.length) return null

  // only Running/Pending pods consume scheduling requests
  const pods = data.pods.filter(p => p.phase === 'Running' || p.phase === 'Pending')
  const chartData = pods
    .filter(p => p.cpu_request > 0)
    .map(p => ({ name: p.name, value: p.cpu_request, limit: p.cpu_limit, phase: p.phase }))
  const totalReq = data.used_cpu
  const alloc = data.allocatable_cpu || 1
  const freePct = Math.max(0, (1 - totalReq / alloc) * 100)
  const usedPct = Math.min(100, totalReq / alloc * 100)

  return (
    <Card padding="lg" className="mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Cpu size={16} className="text-accent" />
        <h3 className="text-sm font-semibold">CPU 预留分布</h3>
        <span className="text-xs text-muted ml-auto">
          {totalReq.toFixed(1)} / {alloc.toFixed(0)} 核
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
                paddingAngle={chartData.length > 12 ? 0.5 : 1.5}
                stroke="rgba(255,255,255,0.6)"
                strokeWidth={1}
                isAnimationActive={false}
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                {...tooltipStyle}
                formatter={(v: any, _n: any, entry: any) => {
                  const limit = entry?.payload?.limit
                  return [`${Number(v).toFixed(2)} 核 (limit ${limit})`, entry?.payload?.name]
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
              {pods.map((p, i) => (
                <tr key={p.name} className="border-b border-black/[0.03] last:border-0 hover:bg-black/[0.02]">
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      <span className="font-mono text-[11px] truncate" title={p.name}>{p.name}</span>
                    </div>
                  </td>
                  <td className="text-right py-1.5 px-2 tnum font-medium">{p.cpu_request.toFixed(2)}</td>
                  <td className="text-right py-1.5 px-2 tnum text-muted">{p.cpu_limit.toFixed(1)}</td>
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
            </tbody>
          </table>
        </div>
      </div>

      {/* footer summary */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-black/[0.05] text-xs text-muted">
        <span>{pods.length} 个 Pod</span>
        <span>内存预留 {data.used_mem_gi.toFixed(1)} / {data.allocatable_mem_gi.toFixed(0)} Gi</span>
        <span className="ml-auto">requests 由 EWMA 自动估算 · 原地 /resize 无重启</span>
      </div>
    </Card>
  )
}
