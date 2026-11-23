import { forwardRef, useState } from 'react'
import { cn } from '@/lib/cn'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, type, ...props }, ref) => {
    const inputId = id || label?.replace(/\s+/g, '-').toLowerCase()
    const [shown, setShown] = useState(false)
    const secret = type === 'password'
    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold text-ink-2">
            {label}
          </label>
        )}
        <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={secret && shown ? 'text' : type}
          className={cn(
            'w-full px-3.5 py-2.5 rounded-[10px] text-sm',
            'border-[0.5px] border-black/8 bg-white/62',
            'placeholder:text-muted/60',
            'focus:outline-none focus:border-accent focus:shadow-[0_0_0_3.5px_rgba(10,132,255,0.18)] focus:bg-white/85',
            'transition-all duration-100',
            error && 'border-bad focus:border-bad focus:shadow-[0_0_0_3.5px_rgba(255,69,58,0.18)]',
            secret && 'pr-16',
            className,
          )}
          {...props}
        />
        {secret && (
          <button
            data-ux="ux-password-reveal"
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 px-2 text-xs text-accent"
            aria-pressed={shown}
            onClick={() => setShown((v) => !v)}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        )}
        </div>
        {(error || hint) && (
          <p className={cn('text-xs', error ? 'text-bad font-medium' : 'text-muted')}>
            {error || hint}
          </p>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'
