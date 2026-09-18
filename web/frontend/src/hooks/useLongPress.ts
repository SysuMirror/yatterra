import { useRef, useCallback, useEffect } from 'react'
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
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const longPressFired = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    pointerRef.current = null
  }, [])

  useEffect(() => {
    if (!enabled) { cancel(); return }
    const finish = (event: PointerEvent) => {
      if (event.pointerId === pointerRef.current?.id) cancel()
    }
    const move = (event: PointerEvent) => {
      const pointer = pointerRef.current
      if (pointer && event.pointerId === pointer.id &&
          Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) cancel()
    }
    const anotherPointer = (event: PointerEvent) => {
      if (pointerRef.current && event.pointerId !== pointerRef.current.id) cancel()
    }
    const visibility = () => { if (document.hidden) cancel() }
    // Observe completion outside the card without retargeting child-button clicks.
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerdown', anotherPointer, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('pagehide', cancel)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('scroll', cancel, true)
    return () => {
      cancel()
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerdown', anotherPointer, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pagehide', cancel)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('scroll', cancel, true)
    }
  }, [enabled, cancel])

  const start = useCallback(
    (e: React.PointerEvent) => {
      cancel()
      longPressFired.current = false
      if (!enabled || !e.isPrimary || e.button !== 0) return
      const target = e.target instanceof Element ? e.target : null
      const control = target?.closest('button, a, input, select, textarea, label, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"]), [tabindex]')
      if (control && control !== e.currentTarget && e.currentTarget.contains(control)) return
      pointerRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
      const event = e.nativeEvent
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        longPressFired.current = true
        haptic('medium')
        onLongPress(event)
      }, delay)
    },
    [onLongPress, delay, enabled, cancel],
  )

  return {
    onPointerDown: start,
    onLostPointerCapture: cancel,
    /** Read whether the most recent interaction was a long press. */
    wasLongPress: () => longPressFired.current,
  }
}
