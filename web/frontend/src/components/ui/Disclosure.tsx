import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { haptic } from '@/lib/haptic'

interface DisclosureProps {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}

export function Disclosure({ title, defaultOpen = false, children, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={cn('border-[0.5px] border-black/[0.06] rounded-xl overflow-hidden', className)}>
      <button
        onClick={() => { haptic('light'); setOpen(!open) }}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold text-ink hover:bg-black/[0.02] active:scale-[0.98] transition-all"
      >
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        >
          <ChevronRight size={16} className="text-muted" />
        </motion.span>
        {title}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 text-sm text-ink-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
