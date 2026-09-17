import { useState, useRef, useEffect, useId } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

interface DropdownItem {
  key: string
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

interface DropdownProps {
  trigger: React.ReactNode
  items: DropdownItem[]
  align?: 'left' | 'right'
  className?: string
}

export function Dropdown({ trigger, items, align = 'right', className }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div ref={ref} className={cn('relative inline-flex', className)}>
      <div ref={triggerRef} role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => { haptic('light'); setOpen(!open) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); haptic('light'); setOpen(!open) } if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); triggerRef.current?.focus() } }}>{trigger}</div>
      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            role="menu"
            className={cn(
              'absolute top-full mt-1 py-1 min-w-[180px] rounded-xl border-[0.5px] border-black/[0.06] bg-white/95 backdrop-blur-xl shadow-2 z-[var(--z-popover)]',
              align === 'right' ? 'right-0' : 'left-0',
            )}
            style={{ paddingBottom: 'calc(0.25rem + var(--sab, 0px))' }}
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12, ease: [0.32, 0.72, 0, 1] }}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { haptic(item.danger ? 'heavy' : 'light'); item.onClick(); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3.5 py-2 text-sm transition-all active:scale-[0.98]',
                  item.danger ? 'text-bad hover:bg-bad-bg' : 'text-ink hover:bg-black/[0.03]',
                  item.disabled && 'opacity-40 pointer-events-none',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
