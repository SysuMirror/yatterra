import { cn } from '@/lib/cn'

type Variant = 'default' | 'ok' | 'warn' | 'bad' | 'accent' | 'muted'

interface BadgeProps {
  variant?: Variant
  dot?: boolean
  children: React.ReactNode
  className?: string
}

const variants: Record<Variant, string> = {
  default: 'bg-black/[0.045] text-ink-2',
  ok: 'bg-ok/10 text-[#1a7f37]',
  warn: 'bg-warn/12 text-[#9a6700]',
  bad: 'bg-bad/10 text-[#cf222e]',
  accent: 'bg-accent/10 text-accent-dark',
  muted: 'bg-black/[0.03] text-muted',
}

const dotColors: Record<Variant, string> = {
  default: 'bg-ink-2',
  ok: 'bg-[#1a7f37]',
  warn: 'bg-warn',
  bad: 'bg-bad',
  accent: 'bg-accent',
  muted: 'bg-muted',
}

export function Badge({ variant = 'default', dot, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium tnum',
        variants[variant],
        className,
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColors[variant])} />}
      {children}
    </span>
  )
}
