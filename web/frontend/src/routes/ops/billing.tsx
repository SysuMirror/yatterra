import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts'
import { Cpu, Download, Gauge, MemoryStick, Receipt, Zap } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { billingApi, type BillingRange, type BillingBucket } from '@/api/billing'
import { useThemeStore } from '@/stores/theme'
import { chartTooltip, axisTick, gridStroke, seriesColor } from '@/lib/chartColors'

const RANGES: { key: BillingRange; label: string }[] = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
]
const BUCKETS: { key: BillingBucket; label: string }[] = [
  { key: 'hour', label: '按小时' },
  { key: 'day', label: '按天' },
]

function bucketLabel(ts: number, bucket: string): string {
  const d = new Date(ts * 1000)
  if (bucket === 'day') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}h`
}

/** 平台计费总览 —— 按组核时/卡时账单（管理员）。 */
export default function OpsBilling() {
  const dark = useThemeStore((s) => s.resolved) === 'dark'
  const [range, setRange] = useState<BillingRange>('7d')
  const [bucket, setBucket] = useState<BillingBucket>('day')

  const { data, isLoading } = useQuery({
    queryKey: ['billing-summary', range, bucket],
    queryFn: () => billingApi.summary(range, bucket),
    staleTime: 60_000,
    retry: false,
  })

  const t = data?.totals
  const series = (data?.series ?? []).map((r) => ({ ...r, label: bucketLabel(r.bucket_start, bucket) }))
  const perGroup = data?.per_group ?? []

  const exportCsv = () => {
    const header = '组,实测核时,申请核时,浪费核时,GPU显存GiB·h,算力卡时'
    const body = perGroup.map((r) =>
      [r.group_name, r.core_hours, r.request_core_hours, r.gap_core_hours, r.gpu_mem_gib_hours, r.compute_card_hours].join(','))
    const csv = [header, ...body].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `billing-${range}-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <PageHeader
        title="计费"
        description="按核时 / 卡时统计各组资源用量（超算式计量）"
        count={perGroup.length > 0 ? `${perGroup.length} 个组` : undefined}
        doc={{ section: 'ops', item: 0, label: '计费说明' }}
      >
        <Button variant="secondary" size="sm" disabled={!perGroup.length} onClick={exportCsv}><Download size={14} /> 导出</Button>
      </PageHeader>

      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {RANGES.map((r) => (
          <button key={r.key} onClick={() => setRange(r.key)}
            className={'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' +
              (range === r.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink hover:bg-black/[0.05]')}>
            {r.label}
          </button>
        ))}
        <span className="mx-1 text-muted/40">|</span>
        {BUCKETS.map((b) => (
          <button key={b.key} onClick={() => setBucket(b.key)}
            className={'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ' +
              (bucket === b.key ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink hover:bg-black/[0.05]')}>
            {b.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3"><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <MetricCard icon={<Cpu size={15} className="text-accent" />} label="实测核时" value={(t?.core_hours ?? 0).toFixed(2)} suffix="核时" />
            <MetricCard icon={<Cpu size={15} className="text-muted" />} label="申请核时" value={(t?.request_core_hours ?? 0).toFixed(2)} suffix="核时" />
            <MetricCard icon={<Gauge size={15} className="text-ok" />} label="整体利用率"
              value={t?.cpu_utilization == null ? '—' : (t.cpu_utilization * 100).toFixed(1)} suffix="%"
              percent={t?.cpu_utilization == null ? undefined : t.cpu_utilization * 100} />
            <MetricCard icon={<Zap size={15} className="text-accent" />} label="算力卡时" value={(t?.compute_card_hours ?? 0).toFixed(2)} suffix="卡时" />
          </div>

          <Card padding="lg" className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Receipt size={15} className="text-accent" />
              <h2 className="text-sm font-semibold">平台核时走势：实测 vs 申请</h2>
            </div>
            {series.length === 0 ? (
              <p className="text-sm text-muted py-10 text-center">该区间暂无用量记录</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={gridStroke(dark)} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis tick={{ fontSize: 10, fill: axisTick(dark) }} tickLine={false} axisLine={false} width={48} />
                    <Tooltip {...chartTooltip(dark)} formatter={(v: any) => `${Number(v).toFixed(2)} 核时`} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="core_hours" name="实测核时" fill={seriesColor(dark, 0)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    <Bar dataKey="request_core_hours" name="申请核时" fill={seriesColor(dark, 1)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card padding="none">
            <DataTable
              columns={[
                { key: 'group_name', title: '组', sortable: true, render: (r: any) => <span className="font-medium text-sm">{r.group_name}</span> },
                { key: 'core_hours', title: '实测核时', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.core_hours.toFixed(3)}</span> },
                { key: 'request_core_hours', title: '申请核时', sortable: true, render: (r: any) => <span className="font-mono text-xs text-muted">{r.request_core_hours.toFixed(3)}</span> },
                { key: 'gap_core_hours', title: '浪费核时', sortable: true, render: (r: any) => <span className={'font-mono text-xs ' + (r.gap_core_hours > 0 ? 'text-warn' : 'text-muted')}>{r.gap_core_hours.toFixed(3)}</span> },
                { key: 'cpu_utilization', title: '利用率', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.cpu_utilization == null ? '—' : `${(r.cpu_utilization * 100).toFixed(0)}%`}</span> },
                { key: 'gpu_mem_gib_hours', title: 'GPU 显存 GiB·h', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.gpu_mem_gib_hours.toFixed(3)}</span> },
                { key: 'compute_card_hours', title: '算力卡时', sortable: true, render: (r: any) => <span className="font-mono text-xs">{r.compute_card_hours.toFixed(3)}</span> },
              ]}
              data={perGroup}
              keyFn={(r: any) => r.group_name}
              empty={<p className="text-sm text-muted py-12 text-center">该区间暂无用量记录</p>}
            />
          </Card>
        </>
      )}
    </>
  )
}
