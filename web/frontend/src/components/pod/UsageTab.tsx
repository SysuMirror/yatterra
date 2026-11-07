import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts'
import { Cpu, Gauge, HardDrive, MemoryStick, Zap } from 'lucide-react'
import { billingApi, type BillingRange } from '@/api/billing'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { DataTable } from '@/components/ui/DataTable'
import { Skeleton } from '@/components/ui/Skeleton'
import { useThemeStore } from '@/stores/theme'
import { chartTooltip, axisTick, gridStroke, seriesColor } from '@/lib/chartColors'

const RANGES: { key: BillingRange; label: string }[] = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
]

function bucketLabel(ts: number, bucket: string): string {
  const d = new Date(ts * 1000)
  if (bucket === 'day') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

/** 用量 / 核时 账单 tab —— CPU 实测核时 vs 申请核时 + GPU 显存/算力卡时。 */
export function UsageTab({ podName }: { podName: string }) {
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const [range, setRange] = useState<BillingRange>('7d')

  const { data, isLoading, error } = useQuery({
    queryKey: ['billing', podName, range],
    queryFn: () => billingApi.pod(podName, range, 'hour'),
    staleTime: 60_000,
    retry: false,
  })

  if (isLoading) return <div className="space-y-3"><Skeleton height={96} /><Skeleton height={260} /></div>
  if (error || !data) return <p className="text-sm text-bad py-8 text-center">{(error as any)?.message || '用量数据暂不可用'}</p>

  const t = data.totals
  const rows = data.series.map((r) => ({ ...r, label: bucketLabel(r.bucket_start, data.bucket) }))

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1.5">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            data-assistant-control={`usage-range-${r.key}`}
            data-assistant-label={`用量区间 ${r.label}`}
            data-assistant-actions="inspect click"
            aria-pressed={range === r.key}
            className={
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' +
              (range === r.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink hover:bg-black/[0.05]')
            }
          >
            {r.label}
          </button>
        ))}
        {data.partial && <span className="ml-1 text-[11px] text-muted">（末尾桶为进行中）</span>}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard icon={<Cpu size={15} className="text-accent" />} label="CPU 实测核时" value={t.core_hours.toFixed(2)} suffix="核时" />
        <MetricCard icon={<Cpu size={15} className="text-muted" />} label="CPU 申请核时" value={t.request_core_hours.toFixed(2)} suffix="核时" />
        <MetricCard
          icon={<Gauge size={15} className="text-ok" />}
          label="CPU 利用率"
          value={t.cpu_utilization == null ? '—' : `${(t.cpu_utilization * 100).toFixed(1)}`}
          suffix="%"
          percent={t.cpu_utilization == null ? undefined : t.cpu_utilization * 100}
        />
        <MetricCard icon={<MemoryStick size={15} className="text-accent" />} label="GPU 显存" value={t.gpu_mem_gib_hours.toFixed(2)} suffix="GiB·h" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard icon={<MemoryStick size={15} className="text-accent" />} label="内存" value={t.mem_gib_hours.toFixed(2)} suffix="GiB·h" />
        <MetricCard icon={<HardDrive size={15} className="text-accent" />} label="存储 · 组目录" value={t.storage_home_gib_hours.toFixed(2)} suffix="GiB·h" />
        <MetricCard icon={<HardDrive size={15} className="text-accent" />} label="存储 · 对象桶" value={t.storage_minio_gib_hours.toFixed(2)} suffix="GiB·h" />
        <MetricCard icon={<Zap size={15} className="text-accent" />} label="算力卡时" value={t.compute_card_hours.toFixed(2)} suffix="卡时" />
      </div>

      <Card padding="lg">
        <div className="flex items-center gap-2 mb-3">
          <Zap size={15} className="text-accent" />
          <h2 className="text-sm font-semibold">核时：实测 vs 申请</h2>
          <span className="text-xs text-muted">差值 = 占着不用的浪费</span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted py-10 text-center">该区间暂无用量记录</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={gridStroke(dark)} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} width={44} />
                <Tooltip {...chartTooltip(dark)} formatter={(v: any) => `${Number(v).toFixed(3)} 核时`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="core_hours" name="实测核时" fill={seriesColor(dark, 0)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="request_core_hours" name="申请核时" fill={seriesColor(dark, 1)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <Card padding="none">
          <DataTable
            columns={[
              { key: 'label', title: '时段', render: (r: any) => <span className="text-xs text-muted">{r.label}</span> },
              { key: 'core_hours', title: '实测核时', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.core_hours.toFixed(3)}</span> },
              { key: 'request_core_hours', title: '申请核时', sortable: true, render: (r: any) => <span className="font-mono text-xs text-muted">{r.request_core_hours.toFixed(3)}</span> },
              { key: 'gpu_mem_gib_hours', title: 'GPU 显存 GiB·h', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.gpu_mem_gib_hours.toFixed(3)}</span> },
              { key: 'compute_card_hours', title: '算力卡时', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.compute_card_hours.toFixed(3)}</span> },
              { key: 'mem_gib_hours', title: '内存 GiB·h', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.mem_gib_hours.toFixed(3)}</span> },
              { key: 'storage_home_gib_hours', title: '存储·目录', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.storage_home_gib_hours.toFixed(3)}</span> },
              { key: 'storage_minio_gib_hours', title: '存储·桶', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.storage_minio_gib_hours.toFixed(3)}</span> },
            ]}
            data={rows}
            keyFn={(r: any) => String(r.bucket_start)}
            empty={<p className="text-sm text-muted text-center">暂无数据</p>}
          />
        </Card>
      )}
    </div>
  )
}
