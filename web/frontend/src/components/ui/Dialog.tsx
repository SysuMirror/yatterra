import { useEffect, useState } from 'react'
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Portal } from '@/components/ui/Portal'

interface DialogProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  width?: string
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onClose, title, description, width = 'max-w-lg', children, className }: DialogProps) {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    setIsMobile(window.matchMedia('(max-width: 767px)').matches)
    const mql = window.matchMedia('(max-width: 767px)')
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  if (isMobile) {
    return <BottomSheet open={open} onClose={onClose} title={title} description={description} className={className}>{children}</BottomSheet>
  }

  return <CenteredDialog open={open} onClose={onClose} title={title} description={description} width={width} className={className}>{children}</CenteredDialog>
}

/** Desktop: centered modal dialog */
function CenteredDialog({ open, onClose, title, description, width = 'max-w-lg', children, className }: DialogProps) {
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
        <motion.div
          data-onboarding-overlay
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            className={cn('relative w-full max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain rounded-2xl p-6', width, className)}
            style={{
              background: 'var(--surface-1)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              border: '0.5px solid rgba(255,255,255,0.5)',
              boxShadow: '0 0 0 0.5px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.12), 0 32px 64px rgba(0,0,0,0.08)',
            }}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors"
            >
              <X size={16} />
            </button>
            {title && (
              <div className="mb-4">
                <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
                {description && <p className="text-sm text-muted mt-1">{description}</p>}
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  )
}

/** Mobile: bottom sheet with drag-to-dismiss */
function BottomSheet({ open, onClose, title, description, children, className }: DialogProps) {
  const y = useMotionValue(0)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Animate in/out
  useEffect(() => {
    if (open) {
      y.set(window.innerHeight)
      const controls = animate(y, 0, { type: 'spring', stiffness: 300, damping: 30 })
      return () => controls.stop()
    }
  }, [open, y])

  // Drag-to-dismiss gesture
  const bind = useDrag(
    ({ movement: [_, my], velocity: [__, vy], active, cancel, canceled }) => {
      if (!open) { cancel(); return }
      if (canceled) { y.set(0); return }

      if (active) {
        // Only allow downward drag
        if (my > 0) {
          // Rubber-band resistance
          const rubber = (my * window.innerHeight * 0.55) / (window.innerHeight + 0.55 * my)
          y.set(rubber)
        } else {
          y.set(0)
        }
        return
      }

      // Dismiss on sufficient drag or fast flick
      if (my > 80 || (my > 30 && vy > 0.3)) {
        onClose()
      } else {
        // Snap back
        animate(y, 0, { type: 'spring', stiffness: 300, damping: 30, velocity: vy })
      }
    },
    {
      axis: 'y',
      enabled: open,
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  return (
    <Portal>
      <AnimatePresence>
      {open && (
        <motion.div data-onboarding-overlay className="fixed inset-0 z-[var(--z-modal)]" exit={{ pointerEvents: 'none' }}>
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />

          {/* Sheet panel */}
          <motion.div
            className={cn(
              'absolute inset-x-0 bottom-0 rounded-t-2xl max-h-[85dvh] flex flex-col overflow-hidden',
              className,
            )}
            style={{
              y,
              paddingBottom: 'var(--sab)',
              background: 'var(--surface-1)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              border: '0.5px solid rgba(255,255,255,0.5)',
              boxShadow: '0 -4px 32px rgba(0,0,0,0.12)',
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          >
            {/* Drag handle */}
            <div {...bind()} className="flex shrink-0 justify-center pt-3 pb-3 touch-none" aria-label="拖动关闭">
              <div className="w-10 h-1 rounded-full bg-black/[0.12]" />
            </div>

            {/* Header */}
            <div className="flex shrink-0 items-center justify-between px-5 pb-2">
              <div>
                {title && <h3 className="text-lg font-semibold tracking-tight">{title}</h3>}
                {description && <p className="text-sm text-muted mt-0.5">{description}</p>}
              </div>
              <button
                onClick={onClose}
                className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="min-h-0 overflow-y-auto overscroll-contain touch-pan-y px-5 pb-5">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </Portal>
  )
}
