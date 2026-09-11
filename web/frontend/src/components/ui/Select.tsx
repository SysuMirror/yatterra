import { useState, useRef, useEffect } from 'react'
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
  className?: string
}

export function Select({ value, onChange, options, placeholder = '选择...', className }: SelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
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
          className="absolute top-full left-0 right-0 mt-1 py-1 rounded-xl border-[0.5px] border-black/[0.06] bg-white/95 backdrop-blur-xl shadow-2 z-50"
          style={{ paddingBottom: 'calc(0.25rem + var(--sab, 0px))' }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
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
