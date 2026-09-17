import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/cn'

type Surface = 1 | 2 | 3

interface CardProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  surface?: Surface
  hover?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  children: React.ReactNode
}

const surfaces: Record<Surface, string> = {
  1: 'bg-[var(--surface-1)]',
  2: 'bg-[var(--surface-2)]',
  3: 'bg-[var(--surface-3)]',
}

const blurs: Record<Surface, string> = {
  1: 'backdrop-blur-[var(--blur-md)]',
  2: 'backdrop-blur-[var(--blur-lg)]',
  3: 'backdrop-blur-[var(--blur-sm)]',
}

const paddings = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
}

export function Card({
  surface = 1,
  hover = false,
  padding = 'md',
  className,
  children,
  ...props
}: CardProps) {
  return (
    <motion.div
      className={cn(
        'rounded-2xl border-[0.5px] border-black/[0.06]',
        surfaces[surface],
        blurs[surface],
        paddings[padding],
        hover && 'cursor-pointer',
        className,
      )}
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}
      whileHover={hover ? { y: -2, boxShadow: '0 8px 24px rgba(0,0,0,.10)' } : undefined}
      whileTap={hover ? { scale: 0.985 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      {...props}
    >
      {children}
    </motion.div>
  )
}
