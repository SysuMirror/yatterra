import { useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/Progress'
import { aiApi } from '@/api/ai'
import { formatBytes } from '@/lib/format'

interface GpuCardProps {
  index: number
  util: number
  memUsed: number
  memTotal: number
  temp: number
  name?: string
  ownMemUsed?: number
}

export function GpuCard({ index, util, memUsed, memTotal, temp, name, ownMemUsed }: GpuCardProps) {
  const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
  const ownPercent = typeof ownMemUsed === 'number' && memTotal > 0 ? (ownMemUsed / memTotal) * 100 : null
  const tempColor = temp > 85 ? 'bad' : temp > 70 ? 'warn' : 'ok'
  const [aiTip, setAiTip] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const handleAiAnalyze = async () => {
    setAiLoading(true)
    setAiTip('')
    try {
      const summary = `GPU ${index} (${name ?? 'unknown'}): 利用率 ${util}%, 显存 ${memUsed}/${memTotal}GB (${memPercent.toFixed(1)}%), 温度 ${temp}°C${ownPercent !== null ? `, 本组占用 ${ownPercent.toFixed(1)}%` : ''}`
      const res = await aiApi.analyze({ text: summary, task: 'explain' })
      setAiTip(res.content)
    } catch {
      setAiTip('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-3 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] active:scale-[0.98] transition-all duration-200">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">GPU {index}</span>
        <div className="flex items-center gap-2">
          {name && <span className="text-xs text-muted">{name}</span>}
          <button
            onClick={handleAiAnalyze}
            disabled={aiLoading}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
            title="AI 分析此 GPU"
          >
            {aiLoading ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
          </button>
        </div>
      </div>
      {aiTip && (
        <div className="p-2 rounded-lg bg-accent/5 border border-accent/10 text-xs whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-0.5 text-[10px] font-semibold text-accent"><Sparkles size={9} /> AI 建议</div>
          {aiTip}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">利用率</span>
          <span className="font-medium">{util.toFixed(0)}%</span>
        </div>
        <Progress value={util} size="sm" color={util > 90 ? 'bad' : util > 70 ? 'warn' : 'accent'} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">整卡显存</span>
          <span className="font-medium">{formatBytes(memUsed * 1024 * 1024)} / {formatBytes(memTotal * 1024 * 1024)}</span>
        </div>
        <Progress value={memPercent} size="sm" color={memPercent > 90 ? 'bad' : memPercent > 70 ? 'warn' : 'accent'} />
      </div>

      {ownPercent !== null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">本组占用</span>
            <span className="font-medium">{formatBytes((ownMemUsed ?? 0) * 1024 * 1024)} / {formatBytes(memTotal * 1024 * 1024)}</span>
          </div>
          <Progress value={ownPercent} size="sm" color="accent" />
        </div>
      )}

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">温度</span>
        <span className={`font-medium ${tempColor === 'bad' ? 'text-bad' : tempColor === 'warn' ? 'text-warn' : 'text-ok'}`}>
          {temp}°C
        </span>
      </div>
    </div>
  )
}
