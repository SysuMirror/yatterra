import { useMemo, useState } from 'react'
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

function cmdOf(rec: ApprovalRecord): string {
  const args = rec.args || {}
  // 兼容旧记录:podwatch 曾用 args.cmd,现统一为 args.command
  return String(args.command ?? args.cmd ?? '')
}

function actionOf(rec: ApprovalRecord): string {
  const args = rec.args || {}
  if (rec.tool === 'run' || rec.tool === 'run_remote') return cmdOf(rec)
  if (rec.tool === 'write_file' || rec.tool === 'edit_file') return `${rec.tool} ${args.path || ''}`
  return JSON.stringify(args).slice(0, 160)
}

// ── 意图分类 ──────────────────────────────────────────────────
// 每条审批记录按「这次动作想达到什么目的」归一类,用于筛选聚合。判定取自
// 记录的 reason(兜底看命令),纯前端计算,故对所有条目生效、无需后端改动。
type IntentKey = 'safety' | 'recover' | 'apply' | 'verify' | 'other'

const INTENTS: { key: IntentKey; label: string; variant: 'bad' | 'warn' | 'accent' | 'ok' | 'muted' }[] = [
  { key: 'safety', label: '止损清理', variant: 'bad' },
  { key: 'recover', label: '故障恢复', variant: 'warn' },
  { key: 'apply', label: '变更生效', variant: 'accent' },
  { key: 'verify', label: '回归验证', variant: 'ok' },
  { key: 'other', label: '其他', variant: 'muted' },
]
const INTENT_BY_KEY = Object.fromEntries(INTENTS.map((i) => [i.key, i])) as Record<
  IntentKey,
  (typeof INTENTS)[number]
>

const INTENT_DOT: Record<string, string> = {
  bad: 'bg-bad',
  warn: 'bg-warn',
  ok: 'bg-ok',
  accent: 'bg-accent',
  muted: 'bg-muted',
}

// 优先级:止损 > 恢复 > 生效 > 验证 > 其他(先命中先归类)
const INTENT_RULES: [IntentKey, RegExp][] = [
  ['safety', /(止损|探针|探测|越权|SSRF|泄露|阻断|清除|终止|移除|扫描|残留|回滚|敏感信息|重置.*环境|防止|防范|封禁|外联|探活)/i],
  ['recover', /(恢复|拉起|失联|异常|崩溃|连接拒绝|健康检查|看门狗|不可控)/i],
  ['apply', /(生效|加载|重新加载|应用变更|重新部署|热更新|最新.*(配置|代码|资源|版本|任务))/i],
  ['verify', /(验证|确认|检查|观察|核验|是否|确保|测试|稳定)/i],
]

function intentOf(rec: ApprovalRecord): IntentKey {
  const text = `${rec.reason || ''} ${cmdOf(rec)}`
  for (const [key, re] of INTENT_RULES) if (re.test(text)) return key
  return 'other'
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
  const [intent, setIntent] = useState<IntentKey | 'all'>('all')
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

  // 按意图聚合计数(在当前状态筛选结果内),用于筛选 chip
  const intentCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of records) {
      const k = intentOf(r)
      c[k] = (c[k] || 0) + 1
    }
    return c
  }, [records])

  const shown = intent === 'all' ? records : records.filter((r) => intentOf(r) === intent)

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

        <div className="flex flex-wrap items-center gap-2 mb-4 pt-3 border-t border-black/[0.06]">
          <span className="text-xs text-muted mr-1">意图</span>
          <button
            onClick={() => setIntent('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              intent === 'all' ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-black/[0.03] hover:text-ink-2'
            }`}
          >
            全部 <span className="tnum opacity-60">{records.length}</span>
          </button>
          {INTENTS.filter((i) => (intentCounts[i.key] || 0) > 0).map((i) => (
            <button
              key={i.key}
              onClick={() => setIntent(intent === i.key ? 'all' : i.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors inline-flex items-center gap-1.5 ${
                intent === i.key ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-black/[0.03] hover:text-ink-2'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${INTENT_DOT[i.variant]}`} />
              {i.label} <span className="tnum opacity-60">{intentCounts[i.key]}</span>
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)}</div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<ShieldQuestion size={22} />}
            title={records.length === 0 ? (filter === 'pending' ? '暂无待审批动作' : '暂无审批记录') : '该意图下暂无记录'}
            description={records.length === 0
              ? (filter === 'pending' ? 'AI agent 的高危写动作会在这里排队等待确认' : '调整筛选条件查看其它状态记录')
              : '换个意图或状态筛选看看'}
          />
        ) : (
          <div className="space-y-3">
            {shown.map((rec) => {
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
                        <Badge variant={INTENT_BY_KEY[intentOf(rec)].variant} dot>
                          {INTENT_BY_KEY[intentOf(rec)].label}
                        </Badge>
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
