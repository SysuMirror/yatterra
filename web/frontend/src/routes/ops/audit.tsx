import { useState, useRef, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, AlertTriangle, LogIn, Users, Download, BarChart3 } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell, CartesianGrid,
} from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant, type PageAiAssistantHandle } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { SearchBar } from '@/components/ui/SearchBar'
import { Select } from '@/components/ui/Select'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { api } from '@/api/client'
import { formatDatetime } from '@/lib/format'

const ACTION_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#ff453a', '#bf5af2', '#64d2ff', '#ff6482', '#ac8e68']

/** Actors that are subsystems rather than people (audit.record(module=...)). */
const MODULE_ACTORS = new Set(['proxy_map', 'minio_svc', 'db_svc', 'deploys', 'scheduler', 'platform', 'webhook', 'app', 'agent', 'harness', 'subagent', 'system'])

const LIMIT_OPTIONS = [
  { value: '50', label: '最近 50' },
  { value: '100', label: '最近 100' },
  { value: '200', label: '最近 200' },
  { value: '500', label: '最近 500' },
]

function actionVariant(action: string): 'bad' | 'ok' | 'accent' | 'muted' {
  const a = action.toLowerCase()
  if (a.includes('fail') || a.includes('delete') || a.includes('remove')) return 'bad'
  if (a.includes('create') || a.includes('start') || a.includes('mkdir')) return 'ok'
  if (a.includes('login') || a.includes('update') || a.includes('stop')) return 'accent'
  return 'muted'
}

function sinceParam(range: string): string | undefined {
  if (range === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  if (range === '7d') {
    const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString()
  }
  return undefined
}

export default function OpsAudit() {
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [dateRange, setDateRange] = useState('')
  const [limit, setLimit] = useState('100')
  const aiRef = useRef<PageAiAssistantHandle>(null)

  const { data, isLoading } = useQuery<any>({
    queryKey: ['audit', { actor, action, dateRange, limit }],
    queryFn: () => {
      const params = new URLSearchParams()
      if (actor) params.set('actor', actor)
      if (action) params.set('action', action)
      params.set('limit', limit)
      const since = sinceParam(dateRange)
      if (since) params.set('since', since)
      return api.get(`/audit?${params}`)
    },
    staleTime: 10_000,
  })

  const items = data?.entries ?? []
  const total = data?.total ?? 0

  // Compute statistics from current items
  const stats = useMemo(() => {
    const failCount = items.filter((r: any) => {
      const a = (r.action || r.type || '').toLowerCase()
      return a.includes('fail') || a.includes('error') || a.includes('delete')
    }).length
    const loginCount = items.filter((r: any) => (r.action || r.type || '').toLowerCase().includes('login')).length
    const uniqueUsers = new Set(items.map((r: any) => r.actor || r.user)).size

    // Action distribution
    const actionMap = new Map<string, number>()
    for (const r of items) {
      const a = r.action || r.type || 'unknown'
      actionMap.set(a, (actionMap.get(a) || 0) + 1)
    }
    const actionDist = Array.from(actionMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }))

    // Hourly heatmap (today only)
    const hourBuckets = Array.from({ length: 24 }, () => 0)
    for (const r of items) {
      const ts = r.ts || r.time
      if (ts) {
        const h = new Date(ts).getHours()
        hourBuckets[h]!++
      }
    }
    const maxHour = Math.max(...hourBuckets, 1)

    return { failCount, loginCount, uniqueUsers, actionDist, hourBuckets, maxHour }
  }, [items])

  const handleSummarize = () => {
    if (!items.length) return
    const lines = items.slice(0, 80).map((r: any) => {
      const ts = formatDatetime(r.ts || r.time)
      return `[${ts}] ${r.action || r.type} (${r.actor || r.user}) ${r.detail || r.target || ''}`
    })
    const prompt = `以下是平台最近的审计日志(${items.length} 条，已按时间倒序)。请总结：1) 近期主要操作和趋势 2) 是否有异常(登录失败、删除、错误) 3) 值得关注的运维建议。给出简洁中文总结，必要时可以跑 kubectl 等命令核实。\n\n${lines.join('\n')}`
    aiRef.current?.send(prompt)
  }

  const handleExportCsv = () => {
    const header = '时间,操作者,操作,详情'
    const rows = items.map((r: any) =>
      [formatDatetime(r.ts || r.time), r.actor || r.user, r.action || r.type, (r.detail || r.target || '').replace(/[,\n]/g, ' ')].join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <PageHeader title="审计日志" description="系统操作审计追踪" count={total > 0 ? `共 ${total} 条` : undefined} doc={{ section: 'ops', item: 0, label: '审计文档' }}>
        <div className="flex items-center gap-2">
          <Button data-onboarding-target="audit-export" variant="secondary" size="sm" disabled={!items.length} onClick={handleExportCsv}><Download size={14} /> 导出</Button>
          <Button variant="secondary" size="sm" disabled={!items.length} onClick={handleSummarize}>让运维助手总结</Button>
          <PageAiAssistant page="audit" ref={aiRef} context={items.length > 0 ? `审计日志: 共 ${total} 条, 当前显示 ${items.length} 条\n最近事件:\n${items.slice(0, 15).map((r: any) => `  ${r.time ?? r.ts ?? ''} ${r.actor ?? '?'} ${r.action ?? ''} ${r.target ?? ''}`).join('\n')}` : ''} />
        </div>
      </PageHeader>

      {/* AI Insight */}
      {!isLoading && items.length > 0 && (
        <AiInsightPanel
          page="audit"
          title="审计日志洞察"
          className="mb-5"
          context={`审计日志: 共 ${total} 条, 当前显示 ${items.length} 条\n失败/删除: ${stats.failCount}, 登录: ${stats.loginCount}, 活跃用户: ${stats.uniqueUsers}\n操作分布: ${stats.actionDist.map(a => `${a.name}(${a.count})`).join(', ')}\n最近事件:\n${items.slice(0, 20).map((r: any) => `  ${r.time ?? r.ts ?? ''} ${r.actor ?? '?'} ${r.action ?? ''} ${r.target ?? r.detail ?? ''}`).join('\n')}`}
        />
      )}

      {/* Stats summary cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 mb-6">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard icon={<ShieldCheck size={15} className="text-accent" />} label="事件总数" value={total} />
            <MetricCard icon={<AlertTriangle size={15} className="text-bad" />} label="失败/删除" value={stats.failCount} />
            <MetricCard icon={<LogIn size={15} className="text-ok" />} label="登录事件" value={stats.loginCount} />
            <MetricCard icon={<Users size={15} className="text-muted" />} label="活跃用户" value={stats.uniqueUsers} />
          </>
        )}
      </div>

      {/* Action type distribution */}
      {stats.actionDist.length > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 size={16} className="text-accent" />
            <h2 className="text-sm font-semibold">操作类型分布</h2>
          </div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.actionDist} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 80 }}>
                <CartesianGrid stroke="rgba(0,0,0,0.05)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#86868b' }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#1d1d1f' }} tickLine={false} axisLine={false} width={76} />
                <Tooltip contentStyle={{ borderRadius: 10, border: '0.5px solid rgba(0,0,0,0.1)', fontSize: 12 }} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {stats.actionDist.map((_: any, i: number) => (
                    <Cell key={i} fill={ACTION_COLORS[i % ACTION_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Hourly heatmap */}
      {stats.maxHour > 0 && (
        <Card padding="lg" className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold">24 小时活动热力图</h2>
          </div>
          <div className="flex gap-0.5">
            {stats.hourBuckets.map((count, h) => {
              const intensity = count / stats.maxHour
              const bg = intensity === 0
                ? 'bg-black/[0.03]'
                : intensity > 0.75
                  ? 'bg-accent/80'
                  : intensity > 0.5
                    ? 'bg-accent/50'
                    : intensity > 0.25
                      ? 'bg-accent/25'
                      : 'bg-accent/10'
              return (
                <div
                  key={h}
                  className={`flex-1 ${bg} rounded-sm h-8 flex items-end justify-center`}
                  title={`${h}:00 — ${count} 事件`}
                >
                  <span className="text-[8px] text-muted mb-0.5">{h}</span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <SearchBar onboardingTarget="audit-search" value={actor} onChange={(v) => { setActor(v) }} placeholder="搜索操作者..." className="max-w-xs" />
        <Select
          onboardingTarget="audit-action"
          value={action}
          onChange={(v) => { setAction(v) }}
          options={[
            { value: '', label: '全部操作' },
            { value: 'pod.create', label: '创建 Pod' },
            { value: 'pod.delete', label: '删除 Pod' },
            { value: 'pod.start', label: '启动 Pod' },
            { value: 'pod.stop', label: '停止 Pod' },
            { value: 'user.login', label: '登录' },
            { value: 'user.create', label: '创建用户' },
          ]}
          className="w-[140px]"
        />
        <Select
          value={dateRange}
          onChange={(v) => { setDateRange(v) }}
          options={[
            { value: '', label: '全部时间' },
            { value: 'today', label: '今天' },
            { value: '7d', label: '最近 7 天' },
          ]}
          className="w-[130px]"
        />
        <Select
          value={limit}
          onChange={(v) => { setLimit(v) }}
          options={LIMIT_OPTIONS}
          className="w-[120px]"
        />
      </div>

      {/* Audit table */}
      <Card padding="none">
        <DataTable
          columns={[
            { key: 'time', title: '时间', sortable: true, width: '180px', render: (r: any) => (
              <span className="text-xs text-muted">{formatDatetime(r.ts || r.time)}</span>
            )},
            { key: 'actor', title: '操作者 / 模块', sortable: true, render: (r: any) => {
              const a = r.actor || r.user || '—'
              // Subsystem entries carry the module name as actor and put the
              // real operator in detail as `by=<user>`; render them distinctly.
              const isModule = MODULE_ACTORS.has(a)
              return (
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-medium">{a}</span>
                  {isModule && <Badge variant="muted" className="text-[10px]">模块</Badge>}
                </span>
              )
            }},
            { key: 'action', title: '操作', render: (r: any) => {
              const a = r.action || r.type
              return <Badge variant={actionVariant(a)}>{a}</Badge>
            }},
            { key: 'detail', title: '详情', render: (r: any) => <span className="text-muted text-xs truncate max-w-[300px] block">{r.detail || r.target || '—'}</span> },
          ]}
          data={Array.isArray(items) ? items : []}
          keyFn={(r: any) => r.id || r.time || Math.random().toString()}
          empty={<p className="text-sm text-muted text-center py-8">暂无审计记录</p>}
        />
      </Card>

      {total > 0 && (
        <div className="flex items-center mt-4 px-1">
          <span className="text-sm text-muted">
            共 {total} 条
          </span>
        </div>
      )}
    </>
  )
}
