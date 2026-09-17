import { useState, useEffect } from 'react'
import { AnimatePresence, motion, useMotionValue, animate } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react'
import { useToastStore, type Toast as ToastType } from '@/stores/toast'
import { motionBind } from '@/lib/gesture'

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const colors = {
  success: 'border-ok/20 bg-ok-bg',
  error: 'border-bad/20 bg-bad-bg',
  warning: 'border-warn/20 bg-warn-bg',
  info: 'border-accent/20 bg-accent-light',
}

const iconColors = {
  success: 'text-ok',
  error: 'text-bad',
  warning: 'text-warn',
  info: 'text-accent',
}

function ToastItem({ toast }: { toast: ToastType }) {
  const Icon = icons[toast.type]
  const remove = useToastStore((s) => s.remove)

  // Swipe-to-dismiss
  const y = useMotionValue(0)

  const bind = useDrag(
    ({ movement: [_, my], velocity: [__, vy], active, cancel }) => {
      if (!active) {
        // Dismiss if swiped up far enough or with sufficient velocity
        if (my < -40 || (my < -20 && vy < -0.3)) {
          animate(y, -100, {
            type: 'spring',
            stiffness: 200,
            damping: 20,
            velocity: vy,
            onComplete: () => remove(toast.id),
          })
        } else {
          // Snap back
          animate(y, 0, { type: 'spring', stiffness: 400, damping: 30, velocity: vy })
        }
      }
    },
    {
      axis: 'y',
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className={`flex items-start gap-3 px-4 py-3 rounded-xl border-[0.5px] ${colors[toast.type]} shadow-2 max-w-[380px]`}
      style={{
        y,
        backdropFilter: 'blur(20px)',
      }}
      {...motionBind(bind())}
    >
      <Icon size={18} className={iconColors[toast.type]} />
      <p className="flex-1 text-sm text-ink">{toast.message}</p>
      <button
        onClick={() => remove(toast.id)}
        className="w-8 h-8 flex items-center justify-center rounded-lg text-muted hover:text-ink hover:bg-black/[0.04] active:bg-black/[0.06] transition-colors flex-shrink-0 -mr-1 -my-1"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    setIsMobile(window.matchMedia('(max-width: 767px)').matches)
    const mql = window.matchMedia('(max-width: 767px)')
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return (
    <div
      className="fixed right-4 z-[var(--z-toast)] flex flex-col gap-2"
      style={{
        top: isMobile ? 'calc(var(--topbar-h) + 0.5rem)' : '1rem',
        left: isMobile ? '1rem' : undefined,
      }}
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  )
}
