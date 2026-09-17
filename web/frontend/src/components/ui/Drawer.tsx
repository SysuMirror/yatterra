import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Portal } from '@/components/ui/Portal'

type Side = 'left' | 'right'

interface DrawerProps {
  open: boolean
  onClose: () => void
  side?: Side
  title?: string
  width?: string
  children: React.ReactNode
  className?: string
}

const slideVariants = {
  left: {
    initial: { x: '-100%' },
    animate: { x: 0 },
    exit: { x: '-100%' },
  },
  right: {
    initial: { x: '100%' },
    animate: { x: 0 },
    exit: { x: '100%' },
  },
}

export function Drawer({ open, onClose, side = 'right', title, width = 'w-[380px] max-w-[calc(100vw-1.5rem)]', children, className }: DrawerProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <Portal>
      <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[var(--z-modal)]">
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />

          {/* Panel */}
          <motion.div
            className={cn(
              'absolute top-0 bottom-0 flex flex-col',
              side === 'left' ? 'left-0' : 'right-0',
              width,
              className,
            )}
            style={{
              background: 'rgba(255,255,255,0.88)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              border: side === 'left' ? 'right: 0.5px solid rgba(0,0,0,0.06)' : 'left: 0.5px solid rgba(0,0,0,0.06)',
              boxShadow: side === 'left'
                ? '4px 0 24px rgba(0,0,0,0.08)'
                : '-4px 0 24px rgba(0,0,0,0.08)',
            }}
            variants={slideVariants[side]}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 h-14 border-b border-black/[0.06]">
              {title && <h3 className="text-sm font-semibold">{title}</h3>}
              <button
                onClick={onClose}
                className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors ml-auto"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {children}
            </div>
          </motion.div>
        </div>
      )}
      </AnimatePresence>
    </Portal>
  )
}
