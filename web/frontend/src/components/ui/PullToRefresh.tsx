import { useState, useRef, useEffect } from 'react'
import { motion, useMotionValue, animate } from 'framer-motion'
import { useDrag } from '@use-gesture/react'
import { RefreshCw, Check } from 'lucide-react'

interface PullToRefreshProps {
  children: React.ReactNode
  /** Called when the user triggers a refresh. Return a promise. */
  onRefresh: () => Promise<void>
  /** Pull distance threshold in px. Default 80. */
  threshold?: number
  /** Enable the gesture. Default true. */
  enabled?: boolean
}

/** Apple-style rubber-band function */
function rubberband(overshoot: number, dim: number, constant = 0.55): number {
  return (overshoot * dim * constant) / (dim + constant * Math.abs(overshoot))
}

/**
 * Pull-to-refresh container.
 *
 * Wrap page content to enable pull-down-to-refresh on mobile.
 * Shows a refresh indicator that follows the finger with rubber-band resistance.
 * Fires `onRefresh` when the user pulls past the threshold and releases.
 */
export function PullToRefresh({ children, onRefresh, threshold = 80, enabled = true }: PullToRefreshProps) {
  const y = useMotionValue(0)
  const [refreshing, setRefreshing] = useState(false)
  const [success, setSuccess] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtTop = useRef(true)
  const generation = useRef(0)
  const busy = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    const reset = () => {
      generation.current += 1
      timers.current.forEach(clearTimeout)
      timers.current = []
      busy.current = false
      isAtTop.current = false
      y.stop()
      y.set(0)
    }
    const interrupt = () => {
      reset()
      setRefreshing(false)
      setSuccess(false)
    }
    const visibility = () => { if (document.hidden) interrupt() }
    if (!enabled) interrupt()
    window.addEventListener('blur', interrupt)
    window.addEventListener('pagehide', interrupt)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      reset()
      window.removeEventListener('blur', interrupt)
      window.removeEventListener('pagehide', interrupt)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled, y])

  // Capture the real scroll ancestors at touch-down. A scroll back to the
  // top must not become a refresh halfway through the same gesture.
  const handleTouchStart = (event: React.TouchEvent) => {
    isAtTop.current = true
    let node = event.target instanceof HTMLElement ? event.target : null
    while (node) {
      if (node.scrollTop > 0) isAtTop.current = false
      node = node.parentElement
    }
  }

  const bind = useDrag(
    ({ movement: [_, my], velocity: [__, vy], active: dragging, cancel, canceled, event }) => {
      if (canceled || event.type === 'touchcancel') { y.stop(); y.set(0); return }
      if (!enabled || busy.current) { cancel(); return }
      // Only activate when scrolled to the top and pulling down
      if (!isAtTop.current) { cancel(); return }

      if (dragging) {
        if (my < 0) {
          y.set(0)
          return
        }
        // Rubber-band resistance
        if (my > threshold) {
          const overshoot = my - threshold
          y.set(threshold + rubberband(overshoot, threshold))
        } else {
          y.set(my)
        }
        return
      }

      // On release
      if (my > threshold || (my > threshold * 0.5 && vy > 0.3)) {
        // Snap to refreshing position
        animate(y, threshold, { type: 'spring', stiffness: 300, damping: 30 })
        busy.current = true
        setRefreshing(true)
        const current = generation.current
        Promise.resolve().then(onRefresh)
          .then(() => {
            if (generation.current !== current) return
            setSuccess(true)
            timers.current.push(setTimeout(() => {
              setSuccess(false)
              animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 })
              timers.current.push(setTimeout(() => {
                busy.current = false
                setRefreshing(false)
              }, 300))
            }, 600))
          })
          .catch(() => {
            if (generation.current !== current) return
            busy.current = false
            animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 })
            setRefreshing(false)
          })
      } else {
        // Spring back
        animate(y, 0, { type: 'spring', stiffness: 400, damping: 30, velocity: vy })
      }
    },
    {
      axis: 'y',
      enabled: enabled && !refreshing,
      filterTaps: false,
      pointer: { touch: true },
    },
  )

  // The indicator follows the pull distance, capped at threshold + some overshoot
  // We derive it from y for smooth animation

  return (
    <div className="relative touch-pan-y" {...bind()} onTouchStartCapture={handleTouchStart}>
      {/* Refresh indicator */}
      <motion.div
        className="absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none z-10"
        style={{ y: y, height: threshold }}
      >
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white/90 shadow-1">
          {success ? (
            <Check size={16} className="text-ok" />
          ) : (
            <motion.div
              animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
              transition={refreshing ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }}
            >
              <RefreshCw size={16} className="text-muted" />
            </motion.div>
          )}
        </div>
      </motion.div>

      {/* Content area */}
      <motion.div
        ref={scrollRef}
        style={{ y }}
      >
        {children}
      </motion.div>
    </div>
  )
}
