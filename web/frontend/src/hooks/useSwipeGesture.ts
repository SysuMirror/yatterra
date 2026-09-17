import { useDrag } from '@use-gesture/react'

/** Return type of useDrag — spread it onto an element to wire up the gesture. */
type DragHandlers = ReturnType<typeof useDrag>

interface SwipeGestureOptions {
  /** Minimum px to travel to trigger. Default 60 */
  threshold?: number
  /** Callback when swiped left */
  onSwipeLeft?: () => void
  /** Callback when swiped right */
  onSwipeRight?: () => void
  /** Callback when swiped up */
  onSwipeUp?: () => void
  /** Callback when swiped down */
  onSwipeDown?: () => void
  /** Axis lock: 'x' | 'y' | undefined. Default undefined (both) */
  axis?: 'x' | 'y'
  /** Enable the gesture. Default true */
  enabled?: boolean
}

/**
 * Lightweight swipe gesture hook built on @use-gesture/react.
 * Returns drag handlers to spread on a motion.div or regular element.
 */
export function useSwipeGesture({
  threshold = 60,
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  axis,
  enabled = true,
}: SwipeGestureOptions): DragHandlers {
  return useDrag(
    ({ movement: [mx, my], velocity: [vx, vy], direction: [dx, dy], cancel, active }) => {
      if (!enabled) {
        cancel()
        return
      }

      // Only fire on release (not during drag) for discrete swipe actions
      if (active) return

      const absX = Math.abs(mx)
      const absY = Math.abs(my)

      // Require either sufficient distance OR high velocity
      const xTriggered = absX > threshold || (absX > 30 && Math.abs(vx) > 0.5)
      const yTriggered = absY > threshold || (absY > 30 && Math.abs(vy) > 0.5)

      if (axis === 'x' || !axis) {
        if (xTriggered) {
          if (dx < 0) onSwipeLeft?.()
          else onSwipeRight?.()
          return
        }
      }

      if (axis === 'y' || !axis) {
        if (yTriggered) {
          if (dy < 0) onSwipeUp?.()
          else onSwipeDown?.()
          return
        }
      }
    },
    {
      axis,
      enabled,
      filterTaps: true,
      pointer: { touch: true },
    },
  )
}

/**
 * Edge swipe detector — fires when user swipes from the very edge of the screen.
 * Used for "swipe from left edge to open sidebar" pattern.
 */
export function useEdgeSwipe({
  edge = 'left',
  edgeWidth = 24,
  threshold = 40,
  onSwipe,
  enabled = true,
}: {
  edge?: 'left' | 'right'
  edgeWidth?: number
  threshold?: number
  onSwipe: () => void
  enabled?: boolean
}): DragHandlers {
  return useDrag(
    ({ movement: [mx], direction: [dx], active, cancel, event }) => {
      if (!enabled) {
        cancel()
        return
      }

      if (active) return

      // Check that the drag started within the edge zone
      const startX = (event as PointerEvent).clientX
      if (edge === 'left' && startX > edgeWidth) {
        cancel()
        return
      }
      if (edge === 'right' && startX < window.innerWidth - edgeWidth) {
        cancel()
        return
      }

      const absX = Math.abs(mx)
      if (absX > threshold) {
        if (edge === 'left' && dx > 0) onSwipe()
        if (edge === 'right' && dx < 0) onSwipe()
      }
    },
    {
      axis: 'x',
      enabled,
      filterTaps: true,
      pointer: { touch: true },
    },
  )
}
