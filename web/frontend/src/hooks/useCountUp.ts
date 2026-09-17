import { useState, useEffect, useRef } from 'react'

/**
 * Animated counter hook — smoothly transitions from one number to another.
 * setInterval-driven (not rAF) so the final value still lands when the tab
 * is backgrounded/throttled; starts from 0 on mount so the first count-up
 * actually runs.
 */
export function useCountUp(
  target: number,
  options: {
    duration?: number
    decimals?: number
    enabled?: boolean
  } = {},
) {
  const { duration = 800, decimals = 0, enabled = true } = options
  const [value, setValue] = useState(enabled ? 0 : target)
  // Start the first animation from 0 (not from target, or diff===0 skips it
  // and the number never counts up on mount).
  const startRef = useRef(enabled ? 0 : target)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    if (!enabled) {
      setValue(target)
      return
    }

    const start = startRef.current
    const diff = target - start
    if (diff === 0) return

    const startTime = performance.now()
    startRef.current = target

    const tick = () => {
      const elapsed = performance.now() - startTime
      const progress = Math.min(elapsed / duration, 1)
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(start + diff * eased)
      if (progress >= 1) {
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = undefined
      }
    }
    tick()
    timerRef.current = setInterval(tick, 16)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = undefined
    }
  }, [target, duration, enabled])

  return decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString()
}
