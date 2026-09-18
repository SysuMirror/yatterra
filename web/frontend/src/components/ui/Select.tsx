import { useState, useRef, useEffect, useId } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  label?: string
  className?: string
  onboardingTarget?: string
}

export function Select({ value, onChange, options, placeholder = '选择...', label, className, onboardingTarget }: SelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()

  useEffect(() => {
    if (!open) return
    const close = () => { setOpen(false); triggerRef.current?.focus() }
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      {label && (
        <label htmlFor={`${listboxId}-trigger`} className="block text-xs font-semibold text-ink-2 mb-1.5">{label}</label>
      )}
      <button
        data-onboarding-target={onboardingTarget}
        ref={triggerRef}
        id={`${listboxId}-trigger`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => { haptic('light'); setOpen(!open) }}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-[10px] text-sm border-[0.5px] border-black/8 bg-white/62 hover:bg-white/72 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3.5px_rgba(10,132,255,0.18)] transition-all duration-100"
      >
        <span className={selected ? 'text-ink' : 'text-muted'}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown size={16} className="text-muted" />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute top-full left-0 right-0 mt-1 py-1 rounded-xl border-[0.5px] border-black/[0.06] bg-white/95 backdrop-blur-xl shadow-2 z-[var(--z-popover)]"
          style={{ paddingBottom: 'calc(0.25rem + var(--sab, 0px))' }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onClick={() => { haptic('light'); onChange(opt.value); setOpen(false) }}
              className={cn(
                'w-full text-left px-3.5 py-2 text-sm transition-all active:scale-[0.98]',
                opt.value === value ? 'text-accent font-medium bg-accent-light' : 'text-ink hover:bg-black/[0.03]',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
