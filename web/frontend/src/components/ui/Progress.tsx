import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

interface ProgressProps {
  value: number // 0-100
  size?: 'sm' | 'md' | 'lg'
  color?: 'accent' | 'ok' | 'warn' | 'bad'
  showLabel?: boolean
  className?: string
}

const heights = { sm: 'h-1', md: 'h-2', lg: 'h-3' }
const barColors = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
}

export function Progress({ value, size = 'md', color = 'accent', showLabel, className }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value))

  return (
    <div className={cn('space-y-1', className)}>
      <div className={cn('w-full rounded-full bg-black/[0.06] overflow-hidden', heights[size])}>
        <motion.div
          className={cn('h-full rounded-full origin-left will-change-transform', barColors[color])}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: clamped / 100 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        />
      </div>
      {showLabel && (
        <p className="text-xs text-muted text-right">{Math.round(clamped)}%</p>
      )}
    </div>
  )
}
