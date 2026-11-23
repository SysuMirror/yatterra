import { useState, useRef, useEffect, useId, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'
import { Portal } from '@/components/ui/Portal'

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

/**
 * 下拉浮层通过 Portal 渲染到 <body> 并用 fixed 定位。
 * 不能用 absolute:表格单元格外层是 `truncate`(overflow:hidden)+
 * `overflow-x-auto` 的滚动容器,absolute 浮层会被裁掉(底部行的菜单
 * 整个不可见),且 white-space:nowrap 会继承进来把选项挤成一行。
 */
export function Select({ value, onChange, options, placeholder = '选择...', label, className, onboardingTarget }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const estH = options.length * 44 + 12
    const flipUp = r.bottom + estH > window.innerHeight && r.top - estH > 8
    setPos(flipUp
      ? { left: r.left, bottom: window.innerHeight - r.top + 4, width: r.width }
      : { left: r.left, top: r.bottom + 4, width: r.width })
  }, [options.length])

  useEffect(() => {
    if (!open) return
    place()
    const close = () => { setOpen(false); triggerRef.current?.focus() }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !listboxRef.current?.contains(t)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
    // 浮层是 fixed,不跟随滚动 —— 页面滚动/resize 时直接收起,避免错位。
    // 注意:capture 阶段会收到浮层自身的 scroll(选项多时 listbox 可滚动),
    // 必须放行来自触发器/浮层内部的滚动,否则一拖动就收起。
    const onScroll = (e: Event) => {
      const t = e.target as Node | null
      if (t && (ref.current?.contains(t) || listboxRef.current?.contains(t))) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, place])

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

      {open && pos && (
        <Portal>
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            className="fixed py-1 rounded-xl border-[0.5px] border-black/[0.06] bg-white/95 backdrop-blur-xl shadow-2 z-[var(--z-popover)] whitespace-normal"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: 'min(60vh, 320px)', overflowY: 'auto', overscrollBehavior: 'contain' } as React.CSSProperties}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => { haptic('light'); onChange(opt.value); setOpen(false) }}
                className={cn(
                  'block w-full text-left px-3.5 py-2 text-sm transition-all active:scale-[0.98]',
                  opt.value === value ? 'text-accent font-medium bg-accent-light' : 'text-ink hover:bg-black/[0.03]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Portal>
      )}
    </div>
  )
}
