import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw, Loader2, GitCommitHorizontal, ScanSearch } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { api } from '@/api/client'
import { useToastStore } from '@/stores/toast'
import { MarkdownContent } from '@/components/ai'

interface ChangeEntry {
  ts: string
  summary: string
  added: number
  modified: number
  removed: number
}

interface Profile {
  pod?: string
  purpose?: string
  stack?: string
  entrypoints?: string
  modules?: string
  summary?: string
  last_change_summary?: string
  last_scan?: string
  deep_notes?: string
  changes?: ChangeEntry[]
}

/** "项目画像" tab — podwatch-maintained picture of what this container runs. */
export function ProfileTab({ podName }: { podName: string }) {
  const toast = useToastStore((s) => s.add)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<{ profile: Profile | null; changes: ChangeEntry[] }>({
    queryKey: ['pod-profile', podName],
    queryFn: () => api.get(`/pods/${podName}/profile`),
    enabled: !!podName,
    staleTime: 30_000,
  })

  const scan = useMutation({
    mutationFn: () => api.post(`/pods/${podName}/profile/scan`),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: ['pod-profile', podName] })
      qc.invalidateQueries({ queryKey: ['insight'] })
      const n = res?.result
      if (n?.pending) {
        toast({ type: 'warning', message: '检测到变更，但平台 LLM 暂不可用，稍后自动重试' })
      } else if (n && n.changed) {
        toast({ type: 'success', message: `扫描完成：+${n.added?.length ?? 0} ~${n.modified?.length ?? 0} -${n.removed?.length ?? 0}` })
      } else {
        toast({ type: 'info', message: '扫描完成：未检测到代码变更' })
      }
    },
    onError: (e: any) => toast({ type: 'error', message: e?.message || '扫描失败' }),
  })

  const prof = data?.profile || null
  const changes = data?.changes || prof?.changes || []

  if (isLoading) {
    return <Card className="flex items-center gap-2 text-sm text-muted"><Loader2 className="animate-spin" size={16} /> 加载画像…</Card>
  }

  return (
    <div className="space-y-4">
      <Card data-onboarding-target="profile-header" className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-black/[0.04] flex items-center justify-center shrink-0">
            <Activity size={18} className="text-accent" />
          </div>
          <div>
            <div className="font-semibold">项目画像</div>
            <div className="text-xs text-muted mt-0.5">
              podwatch 每 10 分钟巡检 <code className="text-[11px]">/home/cloud</code> 的代码变更，用平台 LLM 自动维护
              {prof?.last_scan ? ` · 最近更新 ${prof.last_scan}` : ''}
            </div>
          </div>
        </div>
        <Button data-onboarding-target="profile-scan" variant="secondary" size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 立即扫描
        </Button>
      </Card>

      {!prof ? (
        <EmptyState
          icon={<ScanSearch size={22} />}
          title="暂无画像"
          description="该 Pod 还没有被扫描过，或持久目录里没有可识别的代码。点「立即扫描」建档。"
        />
      ) : (
        <>
          {prof.summary && (
            <Card>
              <div className="text-xs font-medium text-muted mb-1.5">最近变更</div>
              <MarkdownContent content={prof.summary} />
            </Card>
          )}

          <Card data-onboarding-target="profile-content">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="项目用途" value={prof.purpose} />
              <Field label="技术栈" value={prof.stack} />
              <Field label="入口" value={prof.entrypoints} />
              <Field label="主要模块" value={prof.modules} />
            </div>
          </Card>

          {prof.deep_notes && (
            <Card>
              <div className="text-xs font-medium text-muted mb-1.5">深度巡检（subagent）</div>
              <MarkdownContent content={prof.deep_notes} />
            </Card>
          )}

          <Card data-onboarding-target="profile-changes">
            <div className="text-xs font-medium text-muted mb-2 flex items-center gap-1.5">
              <GitCommitHorizontal size={14} /> 变更历史（最近 {changes.length} 次）
            </div>
            {changes.length === 0 ? (
              <div className="text-sm text-muted">暂无变更记录</div>
            ) : (
              <div className="space-y-2">
                {changes.map((c, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-[11px] text-muted whitespace-nowrap pt-0.5">{c.ts}</span>
                    <span className="flex-1">{c.summary || '（无摘要）'}</span>
                    <span className="flex gap-1 shrink-0">
                      {c.added > 0 && <Badge variant="ok">+{c.added}</Badge>}
                      {c.modified > 0 && <Badge variant="warn">~{c.modified}</Badge>}
                      {c.removed > 0 && <Badge variant="bad">-{c.removed}</Badge>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <div className="text-xs text-muted mb-0.5">{label}</div>
      <div className="text-sm">{value || <span className="text-muted">—</span>}</div>
    </div>
  )
}
