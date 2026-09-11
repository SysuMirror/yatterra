import { useCountUp } from '@/hooks/useCountUp'
import { cn } from '@/lib/cn'

interface MetricCardProps {
  icon?: React.ReactNode
  label: string
  value: number | string
  suffix?: string
  /** 0–100; renders an inline usage bar and threshold-tints the value. */
  percent?: number
  /** Force a color; otherwise derived from percent thresholds (neutral by default). */
  color?: 'accent' | 'ok' | 'warn' | 'bad'
  sparkline?: number[]
  className?: string
}

/** Neutral by default — color is earned: green ≤70, amber ≤85, red above. */
function thresholdTone(pct?: number): 'accent' | 'ok' | 'warn' | 'bad' {
  if (pct == null) return 'accent'
  if (pct >= 85) return 'bad'
  if (pct >= 70) return 'warn'
  return 'ok'
}

const valueTone = {
  accent: 'text-ink',
  ok: 'text-ink',
  warn: 'text-[#9a6700]',
  bad: 'text-[#cf222e]',
} as const

const barTone = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
} as const

export function MetricCard({ icon, label, value, suffix = '', percent, color, sparkline, className }: MetricCardProps) {
  const tone = color ?? thresholdTone(percent)
  const isNum = typeof value === 'number'
  const animated = useCountUp(isNum ? (value as number) : 0, {
    duration: 400,
    decimals: isNum && (value as number) % 1 ? 2 : 0,
  })
  const displayValue = isNum ? animated : (value as string)

  return (
    <div className={cn('glass-card p-4 rounded-2xl flex flex-col gap-2 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] active:scale-[0.98] transition-all duration-200', className)}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-muted flex-shrink-0">{icon}</span>}
        <span className="text-xs font-medium text-muted truncate">{label}</span>
      </div>

      <div className="flex items-baseline gap-1 min-w-[3ch]">
        <span className={cn('text-[22px] leading-none font-bold tracking-tight tnum', valueTone[tone])}>
          {displayValue}
        </span>
        {suffix && <span className="text-xs text-muted flex-shrink-0">{suffix}</span>}
      </div>

      {percent != null && (
        <div className="h-1 rounded-full bg-black/[0.06] overflow-hidden" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div
            className={cn('h-full rounded-full origin-left transition-transform duration-500 will-change-transform', barTone[tone])}
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, percent / 100))})` }}
          />
        </div>
      )}

      {sparkline && sparkline.length > 1 && (
        <svg className="w-full h-8" viewBox={`0 0 ${sparkline.length - 1} 1`} preserveAspectRatio="none" aria-hidden>
          <polyline
            fill="none"
            stroke="var(--accent, #0a84ff)"
            strokeWidth="0.03"
            strokeLinejoin="round"
            points={sparkline.map((v, i) => `${i},${1 - v}`).join(' ')}
          />
        </svg>
      )}
    </div>
  )
}
