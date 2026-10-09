import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts'
import { Card } from '@/components/ui/Card'
import { Cpu, MemoryStick, Loader2 } from 'lucide-react'
import { useThemeStore } from '@/stores/theme'
import { piePalette, otherColor } from '@/lib/chartColors'
import { api } from '@/api/client'

interface UsageGroup {
  name: string
  cpu_cores: number
  mem_gi: number
}

interface UsageData {
  cores: number
  mem_total_gi: number
  used_cores: number
  used_mem_gi: number
  groups: UsageGroup[]
}

type Metric = 'cpu' | 'mem'

// Keep the ring readable: top N groups get their own hue, the long tail (this
// host runs ~36 groups) folds into one neutral "其他" slice.
const MAX_SLICES = 8

// Per-metric view of the shared /infra/usage payload — the *live* cgroup v2
// consumption, contrasted with CpuRequestPie's EWMA reservations.
const CFG: Record<Metric, {
  title: string
  unit: string
  icon: typeof Cpu
  loading: string
  value: (g: UsageGroup) => number
  total: (d: UsageData) => number
  used: (d: UsageData) => number
  fmt: (v: number) => string
  fmtTotal: (v: number) => string
}> = {
  cpu: {
    title: 'CPU 实际占用',
    unit: '核',
    icon: Cpu,
    loading: '加载 CPU 占用…',
    value: g => g.cpu_cores,
    total: d => d.cores,
    used: d => d.used_cores,
    fmt: v => v.toFixed(2),
    fmtTotal: v => v.toFixed(0),
  },
  mem: {
    title: '内存实际占用',
    unit: 'Gi',
    icon: MemoryStick,
    loading: '加载内存占用…',
    value: g => g.mem_gi,
    total: d => d.mem_total_gi,
    used: d => d.used_mem_gi,
    fmt: v => v.toFixed(1),
    fmtTotal: v => v.toFixed(0),
  },
}

function LiveUsagePie({ metric }: { metric: Metric }) {
  const c = CFG[metric]
  const Icon = c.icon
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const colors = piePalette(dark)
  const neutral = otherColor(dark)

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

  const { data, isLoading } = useQuery<UsageData>({
    queryKey: ['infra-usage'],
    queryFn: () => api.get('/infra/usage'),
    staleTime: 10_000,
  })

  const { slices, rows, used, total, usedPct } = useMemo(() => {
    const all = (data?.groups ?? []).filter((g) => c.value(g) > 0)
    const total = c.total(data ?? { cores: 0, mem_total_gi: 0, used_cores: 0, used_mem_gi: 0, groups: [] }) || 1
    const used = c.used(data ?? { cores: 0, mem_total_gi: 0, used_cores: 0, used_mem_gi: 0, groups: [] })
    const sorted = all.slice().sort((a, b) => c.value(b) - c.value(a))

    const top = sorted.slice(0, MAX_SLICES)
    const folded = sorted.slice(MAX_SLICES).reduce((s, g) => s + c.value(g), 0)

    const slices = top.map((g, i) => ({
      name: g.name,
      value: c.value(g),
      color: colors[i % colors.length],
    }))
    if (folded > 0) slices.push({ name: '其他', value: folded, color: neutral })

    // legend rows mirror the donut slices exactly (top-N + folded "其他"), so
    // identity is never carried by color alone and nothing is off-chart.
    const rows = slices.map((s) => ({ name: s.name, value: s.value, color: s.color }))

    return {
      slices,
      rows,
      used,
      total,
      usedPct: Math.min(100, (used / total) * 100),
    }
  }, [data, c, colors, neutral])

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

  if (!slices.length) return null

  return (
    <Card padding="lg">
      <div data-onboarding-target="infra-live-usage">
        <div className="flex items-center gap-2 mb-4">
          <Icon size={16} className="text-accent" />
          <h3 className="text-sm font-semibold">{c.title}</h3>
          <span className="text-xs text-muted ml-auto">
            {c.fmt(used)} / {c.fmtTotal(total)} {c.unit}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[minmax(140px,180px)_1fr] gap-4">
          {/* Donut */}
          <div className="relative h-[190px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={1.5}
                  stroke={dark ? '#18222f' : '#ffffff'}
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {slices.map((s, i) => (
                    <Cell key={i} fill={s.color} />
                  ))}
                </Pie>
                <Tooltip
                  {...tooltipStyle}
                  formatter={(v: any, n: any) => [`${c.fmt(Number(v))} ${c.unit}`, n]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-semibold tnum">{usedPct.toFixed(0)}%</span>
              <span className="text-[10px] text-muted">已使用</span>
            </div>
          </div>

          {/* Legend / detail table */}
          <div className="max-h-[210px] overflow-auto -mx-1 px-1">
            <table className="w-full text-xs min-w-[230px]">
              <thead className="sticky top-0 bg-white/80 backdrop-blur-sm">
                <tr className="border-b border-black/[0.06]">
                  <th className="text-left py-1.5 pr-2 text-[10px] text-muted font-medium">组名</th>
                  <th className="text-right py-1.5 px-2 text-[10px] text-muted font-medium">用量 ({c.unit})</th>
                  <th className="text-right py-1.5 pl-2 text-[10px] text-muted font-medium">占比</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.name}-${i}`} className="border-b border-black/[0.03] last:border-0">
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: r.color }} />
                        <span className="font-mono text-[11px] truncate" title={r.name}>{r.name}</span>
                      </div>
                    </td>
                    <td className="text-right py-1.5 px-2 tnum">{c.fmt(r.value)}</td>
                    <td className="text-right py-1.5 pl-2 tnum text-muted">
                      {used > 0 ? ((r.value / used) * 100).toFixed(0) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-black/[0.05] text-xs text-muted">
          {data?.groups.length ?? 0} 个组 · cgroup v2 直采实时值（非预留）
        </div>
      </div>
    </Card>
  )
}

export function CpuUsagePie() {
  return <LiveUsagePie metric="cpu" />
}

export function MemUsagePie() {
  return <LiveUsagePie metric="mem" />
}
