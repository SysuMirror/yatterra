import { useMemo } from 'react'
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip,
} from 'recharts'
import { Progress } from '@/components/ui/Progress'
import { useThemeStore } from '@/stores/theme'
import { formatBytes } from '@/lib/format'
import { piePalette, otherColor } from '@/lib/chartColors'

export interface GpuPodUsage {
  name: string
  mem: number // MiB
  util: number // summed SM utilisation % across the pod's processes
}

interface GpuLike {
  index: number
  mem_used: number
  mem_total: number
  pods?: GpuPodUsage[]
}

// Keep the ring readable: top N pods get their own hue, everything else
// (further pods + driver/宿主 unattributed VRAM) folds into one neutral slice.
const MAX_SLICES = 7

const mbToBytes = (mib: number) => mib * 1024 * 1024

/**
 * Per-GPU live VRAM attribution: a donut of what each Pod is actually holding
 * (from nvidia-smi compute apps, mapped to Pods via cgroup) plus a legend
 * table that also carries each Pod's SM utilisation. The remainder —
 * driver overhead and host-side processes — shows as "其他 / 未归属".
 */
export function GpuPodDonut({ gpu }: { gpu: GpuLike }) {
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

  const { slices, rows, used, usedPct } = useMemo(() => {
    const all = (gpu.pods ?? []).filter((p) => p.mem > 0)
    const used = gpu.mem_used ?? 0
    const total = gpu.mem_total || 1
    const podSum = all.reduce((s, p) => s + p.mem, 0)
    const unattributed = Math.max(0, used - podSum)

    const top = all.slice(0, MAX_SLICES)
    const foldedMem =
      all.slice(MAX_SLICES).reduce((s, p) => s + p.mem, 0) + unattributed

    const slices = top.map((p, i) => ({
      name: p.name,
      value: p.mem,
      color: colors[i % colors.length],
    }))
    if (foldedMem > 0) {
      slices.push({ name: '其他 / 未归属', value: foldedMem, color: neutral })
    }

    const rows = all.map((p, i) => ({
      name: p.name,
      mem: p.mem,
      util: p.util as number | null,
      color: colors[i % colors.length],
    }))
    if (foldedMem > 0) {
      rows.push({ name: '其他 / 未归属', mem: foldedMem, util: null, color: neutral })
    }

    return { slices, rows, used, usedPct: total > 0 ? (used / total) * 100 : 0 }
  }, [gpu, colors, neutral])

  if (!slices.length) {
    return (
      <div data-onboarding-target="gpu-pod-donut">
        <p className="text-[11px] text-muted mb-1.5">按 Pod 实际占用</p>
        <p className="text-xs text-muted">暂无进程占用记录</p>
      </div>
    )
  }

  return (
    <div data-onboarding-target="gpu-pod-donut">
      <p className="text-[11px] text-muted mb-1.5">按 Pod 实际占用</p>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(140px,180px)_1fr] gap-4">
        {/* VRAM donut */}
        <div className="relative h-[170px]">
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
                formatter={(v: any, n: any) => [formatBytes(mbToBytes(Number(v))), n]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-lg font-semibold tnum">{usedPct.toFixed(0)}%</span>
            <span className="text-[10px] text-muted">{formatBytes(mbToBytes(used))}</span>
          </div>
        </div>

        {/* Legend / detail table */}
        <div className="max-h-[190px] overflow-auto -mx-1 px-1">
          <table className="w-full text-xs min-w-[230px]">
            <thead>
              <tr className="border-b border-black/[0.06]">
                <th className="text-left py-1.5 pr-2 text-[10px] text-muted font-medium">Pod</th>
                <th className="text-right py-1.5 px-2 text-[10px] text-muted font-medium">显存</th>
                <th className="text-right py-1.5 px-2 text-[10px] text-muted font-medium">占比</th>
                <th className="text-right py-1.5 pl-2 text-[10px] text-muted font-medium">利用率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.name}-${i}`} className="border-b border-black/[0.03] last:border-0">
                  <td className="py-1.5 pr-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ background: r.color }}
                      />
                      <span className="font-mono text-[11px] truncate" title={r.name}>{r.name}</span>
                    </div>
                  </td>
                  <td className="text-right py-1.5 px-2 tnum">{formatBytes(mbToBytes(r.mem))}</td>
                  <td className="text-right py-1.5 px-2 tnum text-muted">
                    {used > 0 ? ((r.mem / used) * 100).toFixed(0) : 0}%
                  </td>
                  <td className="py-1.5 pl-2">
                    {r.util == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <div className="flex items-center gap-1.5 justify-end">
                        <div className="w-12">
                          <Progress
                            value={Math.min(r.util, 100)}
                            size="sm"
                            color={r.util > 90 ? 'bad' : r.util > 70 ? 'warn' : 'accent'}
                          />
                        </div>
                        <span className="tnum w-7 text-right">{r.util.toFixed(0)}%</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
