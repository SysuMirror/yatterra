import { useRef, useCallback } from 'react'
import { haptic } from '@/lib/haptic'

interface UseLongPressOptions {
  /** Callback fired when the long-press threshold is reached. */
  onLongPress: (e: PointerEvent) => void
  /** Delay in ms before triggering. Default 400. */
  delay?: number
  /** Enable the gesture. Default true. */
  enabled?: boolean
}

/**
 * Long-press gesture hook.
 *
 * Fires `onLongPress` after the pointer is held still for `delay` ms.
 * Moving the pointer, releasing early, or losing capture cancels the press.
 * Provides haptic feedback on trigger (medium impact).
 *
 * Returns pointer event handlers to spread on the target element.
 */
export function useLongPress({
  onLongPress,
  delay = 400,
  enabled = true,
}: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  const start = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      // Capture so we get pointerup even if the pointer leaves
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      longPressFired.current = false
      timerRef.current = setTimeout(() => {
        longPressFired.current = true
        haptic('medium')
        onLongPress(e.nativeEvent)
      }, delay)
    },
    [onLongPress, delay, enabled],
  )

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  return {
    onPointerDown: start,
    onPointerUp: cancel,
    onPointerMove: () => {
      // Any movement cancels the long press — it's a drag, not a hold
      if (!longPressFired.current && timerRef.current !== null) {
        cancel()
      }
    },
    onPointerCancel: cancel,
    /** Read whether the most recent interaction was a long press. */
    wasLongPress: () => longPressFired.current,
  }
}
