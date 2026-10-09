import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldQuestion, Check, X, RefreshCw, Terminal, FileEdit, Globe, Bot } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonCard } from '@/components/ui/Skeleton'
import { approvalsApi, type ApprovalRecord } from '@/api/approvals'
import { useToastStore } from '@/stores/toast'
import { formatDatetime, formatRelativeTime } from '@/lib/format'

type StatusFilter = 'pending' | 'all' | 'done'

const STATUS_BADGE: Record<string, { variant: 'warn' | 'ok' | 'bad' | 'muted'; label: string }> = {
  pending: { variant: 'warn', label: '待审批' },
  executed: { variant: 'ok', label: '已执行' },
  failed: { variant: 'bad', label: '执行失败' },
  rejected: { variant: 'muted', label: '已拒绝' },
}

function actionOf(rec: ApprovalRecord): string {
  const args = rec.args || {}
  if (rec.tool === 'run' || rec.tool === 'run_remote') return String(args.command || '')
  if (rec.tool === 'write_file' || rec.tool === 'edit_file') return `${rec.tool} ${args.path || ''}`
  return JSON.stringify(args).slice(0, 160)
}

function targetOf(rec: ApprovalRecord): string {
  if (rec.tool === 'run_remote') return `远程 ${rec.args?.host || '?'}`
  if (rec.runner === 'pod') return `Pod ${rec.pod || '?'}`
  return '宿主机'
}

function toolIcon(rec: ApprovalRecord) {
  if (rec.tool === 'run' || rec.tool === 'run_remote') return <Terminal size={14} />
  if (rec.tool === 'write_file' || rec.tool === 'edit_file') return <FileEdit size={14} />
  if (rec.tool === 'run_remote') return <Globe size={14} />
  return <Bot size={14} />
}

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<StatusFilter>('pending')
  const [confirm, setConfirm] = useState<{ action: 'approve' | 'reject'; rec: ApprovalRecord } | null>(null)
  const qc = useQueryClient()
  const toast = useToastStore((s) => s.add)

  const { data, isLoading } = useQuery({
    queryKey: ['approvals', filter],
    queryFn: () => approvalsApi.list(filter),
    refetchInterval: 15_000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['approvals'] })
    qc.invalidateQueries({ queryKey: ['audit'] })
  }

  const decide = useMutation({
    mutationFn: (v: { action: 'approve' | 'reject'; rec: ApprovalRecord }) =>
      v.action === 'approve'
        ? approvalsApi.approve(v.rec.id)
        : approvalsApi.reject(v.rec.id),
    onSuccess: (res: any, v) => {
      const ok = res?.ok ?? false
      toast({
        type: ok ? 'success' : 'error',
        message: v.action === 'approve'
          ? (ok ? '已批准并执行' : `执行失败：${res?.message || '未知错误'}`)
          : '已拒绝并作废',
      })
      setConfirm(null)
      invalidate()
    },
    onError: (e: any, v) => toast({
      type: 'error',
      message: v.action === 'approve' ? (e?.message || '批准失败') : (e?.message || '拒绝失败'),
    }),
  })

  const verify = useMutation({
    mutationFn: () => approvalsApi.verify(5),
    onSuccess: (res: any) => toast({ type: 'success', message: `核验完成，共 ${res?.checked ?? 0} 条` }),
    onError: (e: any) => toast({ type: 'error', message: e?.message || '核验失败' }),
  })

  const records = data?.approvals ?? []
  const pendingCount = records.filter((r) => r.status === 'pending').length

  return (
    <>
      <PageHeader title="审批队列" description="AI agent 高危写动作的人工审批与事后核验" doc={{ section: 'ops', item: 0, label: '运维文档' }}>
        <Button
          data-onboarding-target="approvals-verify"
          size="sm"
          variant="outline"
          loading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          <RefreshCw size={14} />
          重新核验
        </Button>
      </PageHeader>

      <Card data-onboarding-target="approvals-list" padding="lg">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {(['pending', 'all', 'done'] as StatusFilter[]).map((f, fi) => (
            <button
              key={f}
              data-onboarding-target={fi === 0 ? 'approvals-filter' : undefined}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-black/[0.03] hover:text-ink-2'
              }`}
            >
              {f === 'pending' ? '待审批' : f === 'all' ? '全部' : '已处理'}
            </button>
          ))}
          {data?.mode && <Badge data-onboarding-target="approvals-mode" variant="muted" className="ml-auto">模式 {data.mode}</Badge>}
        </div>

        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}</div>
        ) : records.length === 0 ? (
          <EmptyState
            icon={<ShieldQuestion size={22} />}
            title={filter === 'pending' ? '暂无待审批动作' : '暂无审批记录'}
            description={filter === 'pending' ? 'AI agent 的高危写动作会在这里排队等待确认' : '调整筛选条件查看其它状态记录'}
          />
        ) : (
          <div className="space-y-3">
            {records.map((rec) => {
              const sb = STATUS_BADGE[rec.status] ?? { variant: 'muted' as const, label: rec.status }
              return (
                <div key={rec.id} data-onboarding-target="approvals-record" className="rounded-xl border border-black/[0.06] p-4 hover:bg-black/[0.015] transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-black/[0.04] flex items-center justify-center text-muted flex-shrink-0 mt-0.5">
                      {toolIcon(rec)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge variant={sb.variant} dot>{sb.label}</Badge>
                        {rec.origin === 'podwatch' && (
                          <Badge variant="accent"><Bot size={11} className="mr-0.5" /> AI 建议</Badge>
                        )}
                        <span className="text-xs text-muted tnum" title={formatDatetime(rec.ts)}>
                          {formatRelativeTime(rec.ts)}
                        </span>
                        <span className="text-xs text-muted">#{rec.id}</span>
                      </div>
                      <pre data-onboarding-target="approvals-action" className="text-sm font-mono text-ink bg-black/[0.03] rounded-lg px-3 py-2 mb-2 whitespace-pre-wrap break-all">
                        {actionOf(rec)}
                      </pre>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted mb-2">
                        <span>目标：<span className="text-ink-2 font-medium">{targetOf(rec)}</span></span>
                        <span>发起：<span className="text-ink-2 font-medium">{rec.agent_id || rec.actor || 'agent'}</span></span>
                        <span>工具：<span className="text-ink-2 font-medium">{rec.tool}</span></span>
                        {rec.decided_by && <span>处理人：<span className="text-ink-2 font-medium">{rec.decided_by}</span></span>}
                      </div>
                      <p className="text-xs text-warn mb-0">⚠ {rec.reason}</p>
                      {rec.status !== 'pending' && rec.exec_out && (
                        <p className="text-xs text-muted mt-2 break-all">
                          结果：{String(rec.exec_out).slice(0, 300)}
                        </p>
                      )}
                      {rec.verify && (
                        <p className="text-xs text-muted mt-1">
                          核验（{rec.verify.status === 'ok' ? '✓ 通过' : rec.verify.status === 'fail' ? '✗ 失败' : '待执行'}）：{rec.verify.cmd}
                        </p>
                      )}
                    </div>
                    {rec.status === 'pending' && (
                      <div className="flex gap-2 flex-shrink-0">
                        <Button data-onboarding-target="approvals-reject" size="sm" variant="danger" onClick={() => setConfirm({ action: 'reject', rec })}>
                          <X size={14} /> 拒绝
                        </Button>
                        <Button data-onboarding-target="approvals-approve" size="sm" onClick={() => setConfirm({ action: 'approve', rec })}>
                          <Check size={14} /> 批准
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {filter === 'pending' && pendingCount > 0 && (
          <p className="text-xs text-muted mt-3">共 {pendingCount} 条待审批，页面每 15 秒自动刷新。</p>
        )}
      </Card>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.action === 'approve' ? '批准执行' : '拒绝动作'}
        description={confirm?.action === 'approve'
          ? '批准后将立即在目标环境执行该命令，请确认风险。'
          : '拒绝后该动作将作废，agent 不会执行它。'}
      >
        {confirm && (
          <div className="space-y-4">
            <pre className="text-sm font-mono text-ink bg-black/[0.03] rounded-lg px-3 py-2 whitespace-pre-wrap break-all">
              {actionOf(confirm.rec)}
            </pre>
            <p className="text-xs text-warn">⚠ {confirm.rec.reason}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>取消</Button>
              <Button
                variant={confirm.action === 'approve' ? 'primary' : 'danger'}
                size="sm"
                loading={decide.isPending}
                onClick={() => decide.mutate(confirm)}
              >
                {confirm.action === 'approve' ? '确认批准' : '确认拒绝'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  )
}
