import { useState, useRef, useCallback } from 'react'
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

  // Track scroll position
  const handleScroll = useCallback(() => {
    isAtTop.current = (scrollRef.current?.scrollTop ?? 0) <= 0
  }, [])

  const bind = useDrag(
    ({ movement: [_, my], velocity: [__, vy], active: dragging, cancel }) => {
      if (!enabled || refreshing) { cancel(); return }
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
        setRefreshing(true)
        onRefresh()
          .then(() => {
            setSuccess(true)
            setTimeout(() => {
              setSuccess(false)
              animate(y, 0, { type: 'spring', stiffness: 400, damping: 30 })
              setTimeout(() => setRefreshing(false), 300)
            }, 600)
          })
          .catch(() => {
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
      filterTaps: true,
      pointer: { touch: true },
    },
  )

  const indicatorY = useMotionValue(0)
  // The indicator follows the pull distance, capped at threshold + some overshoot
  // We derive it from y for smooth animation

  return (
    <div className="relative" {...bind()}>
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
        onScroll={handleScroll}
        style={{ y }}
        className="overflow-y-auto"
      >
        {children}
      </motion.div>
    </div>
  )
}
