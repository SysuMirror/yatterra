import { forwardRef } from 'react'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant
  size?: Size
  loading?: boolean
  children: React.ReactNode
}

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-accent shadow-[0_0_0_0.5px_rgba(10,132,255,0.3),0_2px_8px_rgba(10,132,255,0.2)] hover:bg-accent-dark active:bg-accent-dark',
  secondary:
    'text-ink bg-white/72 border-[0.5px] border-black/8 shadow-1 hover:bg-white/85 active:bg-white/90',
  outline:
    'text-ink-2 bg-transparent border border-black/12 hover:bg-black/[0.03] hover:text-ink active:bg-black/[0.06]',
  ghost: 'text-ink-2 hover:bg-black/[0.04] active:bg-black/[0.06]',
  danger:
    'text-white bg-bad shadow-[0_0_0_0.5px_rgba(255,69,58,0.3),0_2px_8px_rgba(255,69,58,0.2)] hover:bg-[#e03e34] active:bg-[#d63630]',
}

const sizes: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-lg gap-1.5',
  md: 'px-4 py-2 text-sm rounded-xl gap-2',
  lg: 'px-5 py-2.5 text-[15px] rounded-xl gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, className, children, disabled, ...props }, ref) => (
    <motion.button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center font-semibold transition-colors duration-100 select-none',
        'focus-visible:outline-none focus-visible:ring-[3.5px] focus-visible:ring-accent/25',
        variants[variant],
        sizes[size],
        (disabled || loading) && 'opacity-50 pointer-events-none',
        className,
      )}
      disabled={disabled || loading}
      whileTap={!disabled && !loading ? { scale: 0.97 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
      onPointerDown={() => haptic(variant === 'danger' ? 'heavy' : 'light')}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </motion.button>
  ),
)

Button.displayName = 'Button'
