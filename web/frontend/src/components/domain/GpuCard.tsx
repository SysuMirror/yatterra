import { Progress } from '@/components/ui/Progress'
import { formatBytes } from '@/lib/format'

interface GpuCardProps {
  index: number
  util: number
  memUsed: number
  memTotal: number
  temp: number
  name?: string
}

export function GpuCard({ index, util, memUsed, memTotal, temp, name }: GpuCardProps) {
  const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
  const tempColor = temp > 85 ? 'bad' : temp > 70 ? 'warn' : 'ok'

  return (
    <div className="p-4 rounded-xl border-[0.5px] border-black/[0.06] bg-[var(--surface-1)] space-y-3 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] active:scale-[0.98] transition-all duration-200">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">GPU {index}</span>
        {name && <span className="text-xs text-muted">{name}</span>}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">利用率</span>
          <span className="font-medium">{util.toFixed(0)}%</span>
        </div>
        <Progress value={util} size="sm" color={util > 90 ? 'bad' : util > 70 ? 'warn' : 'accent'} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">显存</span>
          <span className="font-medium">{formatBytes(memUsed)} / {formatBytes(memTotal)}</span>
        </div>
        <Progress value={memPercent} size="sm" color={memPercent > 90 ? 'bad' : memPercent > 70 ? 'warn' : 'accent'} />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">温度</span>
        <span className={`font-medium ${tempColor === 'bad' ? 'text-bad' : tempColor === 'warn' ? 'text-warn' : 'text-ok'}`}>
          {temp}°C
        </span>
      </div>
    </div>
  )
}
