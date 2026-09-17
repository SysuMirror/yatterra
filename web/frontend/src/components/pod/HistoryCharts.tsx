import { useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { aiApi } from '@/api/ai'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'

const tooltipStyle = {
  contentStyle: { borderRadius: 10, border: '0.5px solid rgba(0,0,0,0.1)', fontSize: 12, background: 'rgba(255,255,255,0.95)' },
  labelStyle: { color: '#86868b', fontSize: 11 },
}

/** Map a metrics history array into chart rows with stable keys. */
function toRows(series: number[] = []): { i: number; v: number }[] {
  return series.map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }))
}

export default function HistoryCharts({ cpu, mem }: { cpu: number[]; mem: number[] }) {
  const cpuRows = toRows(cpu)
  const memRows = toRows(mem)
  const [aiAnalysis, setAiAnalysis] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  if (cpuRows.length <= 1 && memRows.length <= 1) return null

  const handleAiAnalyze = async () => {
    setAiLoading(true)
    setAiAnalysis('')
    try {
      const cpuAvg = (cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1)
      const memAvg = (mem.reduce((a, b) => a + b, 0) / mem.length).toFixed(1)
      const cpuMax = Math.max(...cpu).toFixed(1)
      const memMax = Math.max(...mem).toFixed(1)
      const summary = `CPU 趋势: 平均 ${cpuAvg}%, 峰值 ${cpuMax}%\n内存趋势: 平均 ${memAvg}%, 峰值 ${memMax}%\n采样点数: ${cpu.length}\nCPU 序列: ${cpu.slice(-20).map(v => v.toFixed(0)).join(', ')}\n内存序列: ${mem.slice(-20).map(v => v.toFixed(0)).join(', ')}`
      const res = await aiApi.analyze({ text: summary, task: 'explain' })
      setAiAnalysis(res.content)
    } catch {
      setAiAnalysis('分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      {aiAnalysis && (
        <div className="p-3 rounded-lg bg-accent/5 border border-accent/10 text-sm whitespace-pre-wrap">
          <div className="flex items-center gap-1 mb-1 text-xs font-semibold text-accent"><Sparkles size={12} /> AI 趋势分析</div>
          {aiAnalysis}
        </div>
      )}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card padding="lg">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold">CPU 趋势</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAiAnalyze}
              disabled={aiLoading}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
            >
              {aiLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              AI 分析
            </button>
            <span className="text-xs text-muted">近 {cpuRows.length} 个采样点</span>
          </div>
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cpuRows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="rgba(0,0,0,0.05)" vertical={false} />
              <XAxis dataKey="i" tick={{ fontSize: 10, fill: '#86868b' }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#86868b' }} tickLine={false} axisLine={false} unit="%" />
              <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, 'CPU']} />
              <Line type="monotone" dataKey="v" stroke="#0a84ff" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card padding="lg">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold">内存趋势</span>
          <span className="text-xs text-muted">近 {memRows.length} 个采样点</span>
        </div>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={memRows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="rgba(0,0,0,0.05)" vertical={false} />
              <XAxis dataKey="i" tick={{ fontSize: 10, fill: '#86868b' }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#86868b' }} tickLine={false} axisLine={false} unit="%" />
              <Tooltip {...tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, '内存']} />
              <Line type="monotone" dataKey="v" stroke="#ff9f0a" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
    </div>
  )
}
