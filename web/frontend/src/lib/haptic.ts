/**
 * Haptic feedback via the Vibration API.
 *
 * Gracefully no-ops on browsers/devices that don't support
 * `navigator.vibrate()` (desktop Safari, SSR, etc.).
 *
 * Patterns follow Apple HIG intent:
 *  - light:     button tap, toggle
 *  - medium:    long-press trigger, drag start
 *  - heavy:     destructive action confirmation
 *  - selection: tab switch, picker change
 */

type HapticType = 'light' | 'medium' | 'heavy' | 'selection'

const PATTERNS: Record<HapticType, VibratePattern> = {
  light: 10,
  medium: 20,
  heavy: [30, 10, 30],
  selection: 5,
}

export function haptic(type: HapticType): void {
  try {
    if ('vibrate' in navigator) {
      navigator.vibrate(PATTERNS[type])
    }
  } catch {
    // SSR or restricted context — silently ignore
  }
}
