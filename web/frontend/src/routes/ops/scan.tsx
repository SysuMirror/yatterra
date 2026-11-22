import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldAlert, ShieldCheck, ScanSearch, RefreshCw, Swords, Search,
  Play, Pause, Plus, ExternalLink, GitBranch, AlertTriangle, Radar,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { PageAiAssistant } from '@/components/domain/PageAiAssistant'
import { AiInsightPanel } from '@/components/domain/AiInsightPanel'
import { MetricCard } from '@/components/domain/MetricCard'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Tabs } from '@/components/ui/Tabs'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { api } from '@/api/client'
import { useAuth } from '@/hooks/useAuth'
import { formatDatetime, formatDuration } from '@/lib/format'

const SEV_LABEL: Record<string, string> = {
  critical: '严重', high: '高危', medium: '中危', low: '低危',
}
function sevVariant(sev?: string): 'bad' | 'warn' | 'accent' | 'muted' {
  switch ((sev || '').toLowerCase()) {
    case 'critical': return 'bad'
    case 'high': return 'warn'
    case 'medium': return 'accent'
    default: return 'muted'
  }
}
function sevHint(sev: string): string {
  return SEV_LABEL[sev] || sev
}

// ── 静态巡检 ────────────────────────────────────────────────────────────────
function StaticPanel() {
  const qc = useQueryClient()
  const { hasPerm } = useAuth()
  const canRun = hasPerm('ops.scan.run')

  const [sev, setSev] = useState('')
  const [status, setStatus] = useState('open')
  const [check, setCheck] = useState('')
  const [q, setQ] = useState('')

  const { data: overview, isLoading } = useQuery<any>({
    queryKey: ['scan-overview'],
    queryFn: () => api.get('/security/overview'),
    staleTime: 10_000,
  })

  const findingsKey = ['scan-findings', sev, status, check, q]
  const { data: findings, isFetching } = useQuery<any>({
    queryKey: findingsKey,
    queryFn: () => {
      const p = new URLSearchParams({ limit: '200' })
      if (sev) p.set('severity', sev)
      if (status) p.set('status', status)
      if (check) p.set('check', check)
      if (q) p.set('q', q)
      return api.get(`/security/findings?${p.toString()}`)
    },
    staleTime: 5_000,
  })

  const runScan = useMutation({
    mutationFn: () => api.post('/security/scan', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scan-overview'] })
      qc.invalidateQueries({ queryKey: ['scan-findings'] })
    },
  })

  const setFindingStatus = useMutation({
    mutationFn: ({ fp, st }: { fp: string; st: string }) =>
      api.post(`/security/findings/${encodeURIComponent(fp)}/status`, { status: st }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scan-findings'] }),
  })

  const scan = overview?.scan || {}
  const bySev = scan.by_severity || {}
  const lastRun = scan.last_run
  const checkOptions = [
    { value: '', label: '全部规则' },
    ...((scan.by_check || []) as any[]).map((c) => ({ value: c.check_id, label: `${c.check_id} (${c.n})` })),
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard icon={<ShieldAlert size={18} />} label="严重" value={bySev.critical ?? 0} color="bad" />
        <MetricCard icon={<AlertTriangle size={18} />} label="高危" value={bySev.high ?? 0} color="warn" />
        <MetricCard icon={<Radar size={18} />} label="中危" value={bySev.medium ?? 0} color="accent" />
        <MetricCard icon={<ShieldCheck size={18} />} label="低危" value={bySev.low ?? 0} color="ok" />
      </div>

      <Card padding="md">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-muted">
            {lastRun ? (
              <>
                最近一次巡检 <span className="text-ink">{formatDatetime(lastRun.ts)}</span>
                {' · '}共 {lastRun.n_total} 项（新增 {lastRun.n_new}）
                {lastRun.duration_s != null && <> · 用时 {formatDuration(lastRun.duration_s)}</>}
                {lastRun.error && <span className="text-bad"> · 错误：{lastRun.error}</span>}
              </>
            ) : (
              <>{isLoading ? '加载中…' : '暂无巡检记录，点击「立即巡检」开始'}</>
            )}
          </div>
          {canRun && (
            <Button
              onClick={() => runScan.mutate()}
              loading={runScan.isPending}
              size="sm"
            >
              <RefreshCw size={16} className="mr-1" />立即巡检
            </Button>
          )}
        </div>
        {runScan.isError && (
          <div className="mt-2 text-sm text-bad">
            巡检失败：{(runScan.error as any)?.message || '未知错误'}
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="p-4 flex items-center gap-2 flex-wrap border-b border-line">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索文件 / 片段…"
              className="pl-8 w-56"
            />
          </div>
          <Select
            value={sev}
            onChange={setSev}
            options={[
              { value: '', label: '全部等级' },
              { value: 'critical', label: '严重' },
              { value: 'high', label: '高危' },
              { value: 'medium', label: '中危' },
              { value: 'low', label: '低危' },
            ]}
            className="w-32"
          />
          <Select
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: '全部状态' },
              { value: 'open', label: '待处理' },
              { value: 'ignored', label: '已忽略' },
              { value: 'resolved', label: '已解决' },
            ]}
            className="w-32"
          />
          <Select
            value={check}
            onChange={setCheck}
            options={checkOptions}
            className="w-56"
          />
          <span className="ml-auto text-sm text-muted tnum">
            {findings?.total ?? 0} 项{isFetching ? ' · 加载中' : ''}
          </span>
        </div>

        {(findings?.items || []).length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<ShieldCheck size={32} />}
              title="没有匹配的巡检结果"
              description="当前过滤条件下没有发现明文密钥或危险代码。"
            />
          </div>
        ) : (
          <div className="divide-y divide-line">
            {(findings.items as any[]).map((f) => (
              <div key={f.fingerprint} className="p-4 flex items-start gap-3">
                <Badge variant={sevVariant(f.severity)}>{sevHint(f.severity)}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-ink">{f.title}</span>
                    <span className="text-xs text-muted font-mono">{f.check_id}</span>
                  </div>
                  <div className="text-sm text-muted mt-0.5 break-all font-mono">
                    {f.file}{f.line ? `:${f.line}` : ''}
                  </div>
                  {f.snippet && (
                    <pre className="mt-1.5 text-xs bg-surface-2 rounded p-2 overflow-x-auto text-muted">
                      {f.snippet}
                    </pre>
                  )}
                  {f.detail && <div className="text-xs text-muted mt-1">{f.detail}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {f.status !== 'resolved' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canRun}
                      onClick={() => setFindingStatus.mutate({ fp: f.fingerprint, st: 'resolved' })}
                    >
                      已解决
                    </Button>
                  )}
                  {f.status !== 'ignored' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canRun}
                      onClick={() => setFindingStatus.mutate({ fp: f.fingerprint, st: 'ignored' })}
                    >
                      忽略
                    </Button>
                  )}
                  {f.status !== 'open' && (
                    <Badge variant="muted">{f.status === 'resolved' ? '已解决' : '已忽略'}</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(overview?.history || []).length > 0 && (
        <Card padding="md">
          <div className="text-sm font-medium text-ink mb-2 flex items-center gap-2">
            <GitBranch size={15} />运行历史
          </div>
          <div className="space-y-1">
            {(overview.history as any[]).map((h) => (
              <div key={h.id} className="flex items-center gap-3 text-sm text-muted">
                <span className="tnum w-40">{formatDatetime(h.ts)}</span>
                <span>{h.trigger}</span>
                <span className="tnum">共 {h.n_total}</span>
                <span className="tnum text-ink">新增 {h.n_new}</span>
                {h.n_crit > 0 && <Badge variant="bad">严重 {h.n_crit}</Badge>}
                {h.n_high > 0 && <Badge variant="warn">高危 {h.n_high}</Badge>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── ARTEX 端到端渗透 ────────────────────────────────────────────────────────
function ArtexPanel() {
  const qc = useQueryClient()
  const { hasPerm } = useAuth()
  const canRun = hasPerm('ops.scan.run')

  const [sev, setSev] = useState('')
  const [task, setTask] = useState('')
  const [page, setPage] = useState(1)
  const [desc, setDesc] = useState('')
  const [goal, setGoal] = useState('')

  const { data: status } = useQuery<any>({
    queryKey: ['artex-status'],
    queryFn: () => api.get('/security/artex').catch(() => null),
    staleTime: 10_000,
  })
  const { data: stats } = useQuery<any>({
    queryKey: ['artex-stats'],
    queryFn: () => api.get('/security/artex/stats').catch(() => null),
    staleTime: 15_000,
  })
  const { data: tasks } = useQuery<any>({
    queryKey: ['artex-tasks'],
    queryFn: () => api.get('/security/artex/tasks').catch(() => null),
    staleTime: 10_000,
  })
  const { data: findings } = useQuery<any>({
    queryKey: ['artex-findings', sev, task, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page), limit: '50' })
      if (sev) p.set('severity', sev)
      if (task) p.set('task', task)
      return api.get(`/security/artex/findings?${p.toString()}`)
    },
    staleTime: 10_000,
  })

  const createTask = useMutation({
    mutationFn: () =>
      api.post('/security/artex/tasks', { description: desc.trim(), goal: goal.trim() }),
    onSuccess: () => {
      setDesc(''); setGoal('')
      qc.invalidateQueries({ queryKey: ['artex-tasks'] })
      qc.invalidateQueries({ queryKey: ['artex-status'] })
    },
  })
  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.post(`/security/artex/tasks/${encodeURIComponent(id)}/control`, { action }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artex-tasks'] }),
  })

  const bySev: Record<string, number> = (stats && (stats.by_severity || stats.severity || stats)) || {}
  const taskList: any[] = (tasks?.tasks || (Array.isArray(tasks) ? tasks : [])) || []
  const activeId = status?.active != null ? String(status.active) : ''
  const findingItems: any[] = findings?.items || []
  const total = findings?.total ?? 0

  return (
    <div className="space-y-5">
      <Card padding="md">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-2 font-medium text-ink">
            <Swords size={18} />ARTEX 自主渗透平台
          </span>
          <Badge variant={status?.ok ? 'ok' : 'bad'} dot>
            {status?.ok ? '在线' : status?.reachable ? '异常' : '不可达'}
          </Badge>
          {status?.version && <span className="text-xs text-muted font-mono">v{status.version}</span>}
          {status?.url && <span className="text-xs text-muted font-mono">{status.url}</span>}
          <span className="ml-auto text-sm text-muted">
            任务 {status?.tasks ?? taskList.length} · 活跃 {status?.active ?? '—'}
          </span>
        </div>
        {!status?.ok && status?.error && (
          <div className="mt-2 text-sm text-bad">连接失败：{status.error}</div>
        )}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard icon={<ShieldAlert size={18} />} label="严重" value={bySev.critical ?? 0} color="bad" />
        <MetricCard icon={<AlertTriangle size={18} />} label="高危" value={bySev.high ?? 0} color="warn" />
        <MetricCard icon={<Radar size={18} />} label="中危" value={bySev.medium ?? 0} color="accent" />
        <MetricCard icon={<ShieldCheck size={18} />} label="低危" value={bySev.low ?? 0} color="ok" />
      </div>

      <Card padding="md">
        <div className="text-sm font-medium text-ink mb-3 flex items-center gap-2">
          <Plus size={15} />新建渗透任务
        </div>
        <div className="space-y-2">
          <Input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="目标描述，如：对 https://example.com 做端到端渗透，重点测试越权与注入"
            disabled={!canRun}
          />
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="目标（可选）：例如 获取管理员凭证 / 找出全部高危"
            disabled={!canRun}
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={() => createTask.mutate()}
              disabled={!canRun || !desc.trim()}
              loading={createTask.isPending}
              size="sm"
            >
              创建任务
            </Button>
            {!canRun && <span className="text-xs text-muted">需要 ops.scan.run 权限</span>}
            {createTask.isError && (
              <span className="text-sm text-bad">{(createTask.error as any)?.message || '创建失败'}</span>
            )}
          </div>
        </div>
      </Card>

      <Card padding="none">
        <div className="p-4 border-b border-line text-sm font-medium text-ink">渗透任务</div>
        {taskList.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<Swords size={32} />} title="暂无任务" description="创建一个任务开始端到端渗透。" />
          </div>
        ) : (
          <div className="divide-y divide-line">
            {taskList.map((t) => {
              const st = String(t.status || '').toLowerCase()
              const isActive = String(t.id) === activeId
              const live = (st === 'running' || st === 'active' || isActive) && st !== 'paused'
              const badge: 'ok' | 'warn' | 'muted' =
                st === 'paused' ? 'warn' : live ? 'ok' : st === 'completed' ? 'muted' : 'muted'
              const label = t.paused ? '已暂停' : t.status || (live ? '运行中' : '—')
              return (
              <div key={t.id} className="p-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-ink truncate">{t.name || t.description || t.id}</span>
                    <Badge variant={badge} dot={live}>{label}</Badge>
                    {isActive && <Badge variant="accent">当前</Badge>}
                  </div>
                  <div className="text-xs text-muted font-mono mt-0.5 truncate">
                    {t.id}
                    {t.created_at ? ` · ${formatDatetime(t.created_at)}` : ''}
                    {t.findings != null ? ` · ${t.findings} 项结果` : ''}
                  </div>
                </div>
                {canRun && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => control.mutate({ id: t.id, action: 'resume' })}
                      disabled={control.isPending || !t.paused}
                    >
                      <Play size={14} className="mr-1" />恢复
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => control.mutate({ id: t.id, action: 'pause' })}
                      disabled={control.isPending || !!t.paused}
                    >
                      <Pause size={14} className="mr-1" />暂停
                    </Button>
                  </div>
                )}
              </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="p-4 flex items-center gap-2 flex-wrap border-b border-line">
          <span className="text-sm font-medium text-ink">漏洞结果</span>
          <Select
            value={sev}
            onChange={(v) => { setSev(v); setPage(1) }}
            options={[
              { value: '', label: '全部等级' },
              { value: 'critical', label: '严重' },
              { value: 'high', label: '高危' },
              { value: 'medium', label: '中危' },
              { value: 'low', label: '低危' },
            ]}
            className="w-32"
          />
          <Select
            value={task}
            onChange={(v) => { setTask(v); setPage(1) }}
            options={[{ value: '', label: '全部任务' }, ...taskList.map((t) => ({ value: t.id, label: t.name || t.id }))]}
            className="w-48"
          />
          <span className="ml-auto text-sm text-muted tnum">{total} 项</span>
        </div>
        {findingItems.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={<ShieldCheck size={32} />} title="暂无漏洞结果" description="ARTEX 尚未在此条件下产生结果。" />
          </div>
        ) : (
          <div className="divide-y divide-line">
            {findingItems.map((f) => (
              <div key={f.id} className="p-4 flex items-start gap-3">
                <Badge variant={sevVariant(f.severity)}>{sevHint(f.severity)}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-ink">{f.vulnclass || '漏洞'}</span>
                    <span className="text-xs text-muted">{f.status}</span>
                  </div>
                  <div className="text-sm text-muted mt-0.5 break-words">{f.summary}</div>
                  {Array.isArray(f.assets) && f.assets.length > 0 && (
                    <div className="text-xs text-muted font-mono mt-1 break-all">
                      {f.assets.map((a: any) => a?.url || a?.host || a?.name || String(a)).slice(0, 4).join(', ')}
                    </div>
                  )}
                </div>
                {f.ts && <span className="text-xs text-muted shrink-0">{formatDatetime(f.ts)}</span>}
              </div>
            ))}
          </div>
        )}
        {total > 50 && (
          <div className="p-3 flex items-center justify-center gap-3 border-t border-line">
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              上一页
            </Button>
            <span className="text-sm text-muted tnum">第 {page} 页</span>
            <Button
              variant="ghost" size="sm"
              disabled={page * 50 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </Card>

      <div className="text-xs text-muted flex items-center gap-1">
        <ExternalLink size={12} />
        ARTEX 平台自带 Web 界面与更细的报告；本页为运维板内的聚合视图。
      </div>
    </div>
  )
}

export default function ScanPage() {
  const [tab, setTab] = useState('static')
  const { data: overview } = useQuery<any>({
    queryKey: ['scan-overview'],
    queryFn: () => api.get('/security/overview').catch(() => null),
    staleTime: 10_000,
  })
  const scan = overview?.scan || {}
  const s = scan.by_severity || {}
  const top = ((scan.by_check || []) as any[]).slice(0, 6)
    .map((c) => `${c.check_id}×${c.n}`).join(', ')
  const ctx = `安全巡检：明文密钥/危险代码/集群配置 共 ${scan.total ?? 0} 项 `
    + `(严重 ${s.critical ?? 0} / 高危 ${s.high ?? 0} / 中危 ${s.medium ?? 0} / 低危 ${s.low ?? 0})；`
    + `覆盖文件 ${scan.files ?? 0} 个；Top 规则：${top || '无'}；`
    + `ARTEX 渗透平台 ${overview?.artex?.ok ? '在线' : '不可达'}`
    + (overview?.artex?.tasks != null ? `，任务 ${overview.artex.tasks} 个` : '')
  const tabs = [
    { key: 'static', label: '静态巡检', icon: <ScanSearch size={16} /> },
    { key: 'artex', label: 'ARTEX 渗透', icon: <Swords size={16} /> },
  ]
  return (
    <div>
      <PageHeader
        title="安全巡检"
        description="明文密钥 / 危险代码 / 集群配置 + ARTEX 端到端渗透"
        doc={{ section: 'ops' }}
      />
      <AiInsightPanel page="scan" title="安全巡检洞察" context={ctx} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} swipeable className="mb-5" />
      {tab === 'static' ? <StaticPanel /> : <ArtexPanel />}
      <PageAiAssistant page="scan" context={ctx} />
    </div>
  )
}
