import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatRelativeTime } from '@/lib/format'
import { Play, Square, Trash2, Sparkles, Loader2 } from 'lucide-react'
import { aiApi } from '@/api/ai'

interface DeployRowProps {
  name: string
  status: 'running' | 'stopped' | 'failed'
  createdAt: string
  lastRun?: string
  onRun?: () => void
  onStop?: () => void
  onDelete?: () => void
}

const statusMap = {
  running: { variant: 'ok' as const, label: '运行中' },
  stopped: { variant: 'muted' as const, label: '已停止' },
  failed: { variant: 'bad' as const, label: '失败' },
}

export function DeployRow({ name, status, createdAt, lastRun, onRun, onStop, onDelete }: DeployRowProps) {
  const s = statusMap[status]
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAnalyze = async () => {
    if (aiTip) { setAiTip(''); return }
    setAiLoading(true)
    try {
      const res = await aiApi.explain(`部署任务: ${name}, 状态: ${s.label}, 创建时间: ${createdAt}, 上次运行: ${lastRun ?? '无'}`)
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="px-4 py-3 rounded-xl hover:bg-black/[0.02] active:bg-black/[0.04] active:scale-[0.99] transition-all group">
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{name}</span>
            <Badge variant={s.variant} dot>{s.label}</Badge>
          </div>
          <div className="text-xs text-muted mt-0.5">
            创建于 {formatRelativeTime(createdAt)}
            {lastRun && ` · 上次运行 ${formatRelativeTime(lastRun)}`}
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" onClick={handleAiAnalyze} title="AI 分析">
            {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} className="text-accent" />}
          </Button>
          {status === 'running' ? (
            <Button variant="ghost" size="sm" onClick={onStop}><Square size={14} /> 停止</Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onRun}><Play size={14} /> 运行</Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDelete}><Trash2 size={14} /></Button>
        </div>
      </div>
      {aiTip && (
        <div className="mt-2 p-2 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-0.5 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 分析</div>
          {aiTip}
        </div>
      )}
    </div>
  )
}
