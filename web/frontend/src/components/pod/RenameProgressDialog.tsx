import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, Loader2, XCircle, Server } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Progress } from '@/components/ui/Progress'
import { Button } from '@/components/ui/Button'
import { useSSE } from '@/hooks/useSSE'

type StepStatus = 'running' | 'done' | 'error'
export interface RenameStep {
  key: string
  label: string
  status: StepStatus
  node?: string
  pct?: number | null
  detail?: string
}

/**
 * Follows a background rename job over SSE and shows each step (and the node
 * it runs on) as it happens. Replaces the old "spinner until it either works
 * or 404s" rename button.
 */
export function RenameProgressDialog({
  open, onClose, jobId, podName, onDone,
}: {
  open: boolean
  onClose: () => void
  jobId: string | null
  podName: string
  onDone: (newName: string) => void
}) {
  const [steps, setSteps] = useState<RenameStep[]>([])
  const [pct, setPct] = useState(0)
  const [node, setNode] = useState('')
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running')
  const [err, setErr] = useState('')
  const [newName, setNewName] = useState('')
  const [note, setNote] = useState('')
  const [finished, setFinished] = useState(false)
  const navigated = useRef(false)

  // Fresh job → fresh state.
  useEffect(() => {
    if (!jobId) return
    setSteps([]); setPct(0); setNode(''); setPhase('running'); setErr(''); setNewName(''); setNote(''); setFinished(false)
    navigated.current = false
  }, [jobId])

  const url = open && jobId && !finished ? `/api/pods/rename-jobs/${jobId}/stream` : null
  useSSE(url, {
    onMessage: (data) => {
      let ev: any
      try { ev = JSON.parse(data) } catch { return }
      if (ev.type === 'start') {
        setNode(ev.node || '')
        setPct(2)
        return
      }
      if (ev.type === 'step') {
        setSteps((prev) => {
          const i = prev.findIndex((s) => s.key === ev.key)
          if (i >= 0) return prev.map((s, idx) => (idx === i ? { ...s, ...ev } : s))
          return [...prev, ev]
        })
        // steps run in parallel (k8s release ‖ frpc/nginx rewrite) → never let
        // the bar move backwards
        if (typeof ev.pct === 'number') setPct((p) => Math.max(p, ev.pct as number))
        if (ev.key === 'done' && ev.detail) setNote(ev.detail)
        return
      }
      if (ev.type === 'result') {
        setPct(100); setPhase('done'); setNewName(ev.name || ''); setFinished(true)
        return
      }
      if (ev.type === 'failed') {
        setPhase('error'); setErr(ev.error || '改名失败'); setFinished(true)
      }
    },
  })

  // Auto-jump to the renamed pod once it's up.
  useEffect(() => {
    if (phase !== 'done' || !newName || navigated.current) return
    navigated.current = true
    const t = setTimeout(() => onDone(newName), 1200)
    return () => clearTimeout(t)
  }, [phase, newName, onDone])

  const running = phase === 'running'

  return (
    <Dialog
      open={open}
      onClose={() => { if (!running) onClose() }}
      title="正在改名"
      description={`${podName} → 新名字（公网端口不变）`}
      width="max-w-md"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Server size={13} className="text-accent" />
          <span>执行节点</span>
          <span className="font-mono text-ink-2">{node || '…'}</span>
        </div>

        <Progress
          value={pct}
          color={phase === 'error' ? 'bad' : phase === 'done' ? 'ok' : 'accent'}
          showLabel
        />

        <ol className="space-y-2">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 flex-shrink-0">
                {s.status === 'done' ? (
                  <CheckCircle2 size={15} className="text-ok" />
                ) : s.status === 'error' ? (
                  <XCircle size={15} className="text-bad" />
                ) : (
                  <Loader2 size={15} className="text-accent animate-spin" />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className={s.status === 'error' ? 'text-bad' : 'text-ink-2'}>{s.label}</span>
                {s.node && <span className="ml-2 font-mono text-[11px] text-muted">@{s.node}</span>}
                {s.detail && (
                  <span className="block text-[11px] text-muted break-all">{s.detail}</span>
                )}
              </span>
            </li>
          ))}
          {!steps.length && (
            <li className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={15} className="animate-spin" />
              正在提交改名请求…
            </li>
          )}
        </ol>

        {phase === 'done' && (
          <p className="text-sm text-ok">改名完成{newName ? `：${newName}` : ''}，正在跳转…</p>
        )}
        {phase === 'done' && note.includes('注意：') && (
          <p className="text-xs text-warn break-all">{note.split('注意：').slice(1).join('注意：')}</p>
        )}
        {phase === 'error' && (
          <p className="text-sm text-bad break-all">改名失败：{err}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {running ? (
            <span className="text-xs text-muted mr-auto flex items-center gap-1">
              <Circle size={8} className="fill-current" /> 改名在后台进行，请勿关闭页面
            </span>
          ) : (
            <Button
              size="sm"
              variant={phase === 'error' ? 'secondary' : 'primary'}
              onClick={() => (phase === 'done' && newName ? onDone(newName) : onClose())}
            >
              {phase === 'done' ? '前往新 Pod' : '关闭'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
