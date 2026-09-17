/**
 * App Badging API wrapper for PWA.
 * Sets a numeric badge on the installed app icon (Windows/macOS dock/taskbar).
 * Android shows a dot instead of a number.
 * No-op when API is unavailable (e.g. in-browser, unsupported OS).
 */

/** Set the app badge to a non-negative number. 0 clears it. */
export function setAppBadge(count: number): void {
  if (count <= 0) {
    clearAppBadge()
    return
  }
  try {
    navigator.setAppBadge?.(count)?.catch?.(() => {})
  } catch { /* not available */ }
}

/** Clear the app badge. */
export function clearAppBadge(): void {
  try {
    navigator.clearAppBadge?.()?.catch?.(() => {})
  } catch { /* not available */ }
}

/** Set a dot-style badge (no number). */
export function setAppBadgeDot(): void {
  try {
    navigator.setAppBadge?.()?.catch?.(() => {})
  } catch { /* not available */ }
}
