import { lazy, Suspense, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CalendarClock, Sparkles, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Progress } from '@/components/ui/Progress'
import { GpuCard } from '@/components/domain/GpuCard'
import { aiApi } from '@/api/ai'
import { api } from '@/api/client'
import { formatBytes, formatRelativeTime } from '@/lib/format'
import { Skeleton } from '@/components/ui/Skeleton'

// Lazy-load the recharts-dependent chart panel (~495 KiB).
// This prevents recharts and its shared deps (redux, reselect, immer)
// from being eagerly loaded on every page.
const HistoryCharts = lazy(() => import('./HistoryCharts'))

export function MonitorTab({ metrics, history, pod }: { metrics: any; history: any; pod: any }) {
  const [aiAnalysis, setAiAnalysis] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAnalyze = async () => {
    setAiLoading(true)
    setAiAnalysis('')
    const summary = [
      `CPU: ${(metrics?.cpu_percent ?? 0).toFixed(1)}%`,
      `内存: ${formatBytes((metrics?.mem_used ?? 0) * 1024 * 1024)} / ${formatBytes((metrics?.mem_total ?? 0) * 1024 * 1024)} (${(metrics?.mem_percent ?? 0).toFixed(1)}%)`,
      ...(metrics?.gpus?.length > 0
        ? metrics.gpus.map((g: any) => `GPU ${g.index}: 利用率 ${g.util}%, 显存 ${formatBytes((g.mem_used ?? 0) * 1024 * 1024)}/${formatBytes((g.mem_total ?? 0) * 1024 * 1024)}, 温度 ${g.temp}°C`)
        : []),
      `Pod 规格: CPU ${pod?.cpu ?? '?'}核, 内存 ${pod?.mem ?? '?'}GB, 存储 ${pod?.storage ?? '?'}GB`,
    ].join('\n')
    try {
      const res = await aiApi.analyze({
        text: summary,
        task: 'explain',
      })
      setAiAnalysis(res.content)
    } catch {
      setAiAnalysis('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* AI analysis button + result */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleAiAnalyze}
          disabled={aiLoading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
        >
          {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {aiLoading ? '分析中...' : 'AI 分析资源使用'}
        </button>
      </div>
      {aiAnalysis && (
        <Card padding="lg">
          <div className="flex items-center gap-1 mb-2 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 分析</div>
          <div className="text-sm whitespace-pre-wrap">{aiAnalysis}</div>
        </Card>
      )}

      {/* Current CPU & memory */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card padding="lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">CPU</span>
            <span className="text-sm font-medium tnum">{(metrics?.cpu_percent ?? 0).toFixed(1)}%</span>
          </div>
          <Progress value={metrics?.cpu_percent ?? 0} size="lg" color={metrics?.cpu_percent > 90 ? 'bad' : 'accent'} showLabel />
        </Card>
        <Card padding="lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">内存</span>
            <span className="text-sm font-medium tnum">
              {formatBytes((metrics?.mem_used ?? 0) * 1024 * 1024)} / {formatBytes((metrics?.mem_total ?? 0) * 1024 * 1024)}
            </span>
          </div>
          <Progress value={metrics?.mem_percent ?? 0} size="lg" color={metrics?.mem_percent > 90 ? 'bad' : 'warn'} showLabel />
        </Card>
      </div>

      {/* History charts — lazy-loaded with recharts (~495 KiB) */}
      <Suspense fallback={<Skeleton height={180} className="w-full" />}>
        <HistoryCharts cpu={history?.cpu} mem={history?.mem} />
      </Suspense>

      {/* GPUs */}
      {metrics?.gpus?.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3">GPU</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {metrics.gpus.map((g: any) => (
              <GpuCard key={g.index} index={g.index} util={g.util} memUsed={g.mem_used} memTotal={g.mem_total} temp={g.temp} ownMemUsed={g.own_mem_used} />
            ))}
          </div>
        </div>
      )}

      {/* Events */}
      <EventsCard podName={pod?.name} />

      {pod?.lifecycle?.phase && (
        <Card padding="md">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">阶段:</span>
            <Badge variant="accent">{pod.lifecycle.phase}</Badge>
          </div>
        </Card>
      )}
    </div>
  )
}

function EventsCard({ podName }: { podName?: string }) {
  const { data } = useQuery<{ events: any[] }>({
    queryKey: ['pod-events', podName],
    queryFn: () => api.get(`/pods/${podName}/events`),
    enabled: !!podName,
    refetchInterval: 30_000,
  })
  const events = data?.events ?? []
  if (!events.length) return null

  return (
    <Card padding="lg">
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock size={15} className="text-muted" />
        <h3 className="text-sm font-semibold">最近事件</h3>
        <Badge variant="muted" className="ml-auto">{events.length}</Badge>
      </div>
      <ul className="space-y-2 max-h-64 overflow-y-auto">
        {events.slice(0, 30).map((e: any, i: number) => {
          const ts = e.ts ?? e.time ?? e.last_seen ?? e.first_seen ?? e.timestamp
          const type = e.type ?? e.reason ?? ''
          const msg = e.message ?? e.note ?? e.obj ?? JSON.stringify(e)
          const isWarn = /warn|fail|kill|backoff|unhealthy|error/i.test(type + ' ' + msg)
          return (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              {isWarn
                ? <AlertCircle size={14} className="text-warn flex-shrink-0 mt-0.5" />
                : <span className="w-[14px] h-[14px] rounded-full bg-ok/60 flex-shrink-0 mt-1" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {type && <span className="text-xs font-medium text-ink-2 font-mono">{type}</span>}
                  {ts && <span className="text-[11px] text-muted">{formatRelativeTime(String(ts))}</span>}
                </div>
                <p className="text-xs text-muted mt-0.5 break-all line-clamp-2" title={msg}>{msg}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
