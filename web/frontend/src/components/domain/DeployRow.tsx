import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatRelativeTime } from '@/lib/format'
import { Play, Square, Trash2 } from 'lucide-react'

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

  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-black/[0.02] active:bg-black/[0.04] active:scale-[0.99] transition-all group">
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
        {status === 'running' ? (
          <Button variant="ghost" size="sm" onClick={onStop}><Square size={14} /> 停止</Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onRun}><Play size={14} /> 运行</Button>
        )}
        <Button variant="ghost" size="sm" onClick={onDelete}><Trash2 size={14} /></Button>
      </div>
    </div>
  )
}
