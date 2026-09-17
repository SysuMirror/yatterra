/**
 * Service Worker manual update check — native SW API, no virtual modules.
 *
 * Flow:
 * 1. checkForUpdate() → forces browser to ask server for new SW
 * 2. New SW found → installs → skipWaiting() (built-in) → activates
 * 3. controllerchange fires → main.tsx listener reloads page
 *
 * If no update: resolves false.
 */

export type UpdateStatus = 'idle' | 'checking' | 'found' | 'up-to-date' | 'error'

let _status: UpdateStatus = 'idle'
let _onChange: ((s: UpdateStatus) => void) | undefined = undefined

export function onStatusChange(fn: (s: UpdateStatus) => void) { _onChange = fn }
export function getStatus(): UpdateStatus { return _status }

function setStatus(s: UpdateStatus) { _status = s; _onChange?.(s) }

export async function checkForUpdate(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    setStatus('error')
    return false
  }

  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) {
    setStatus('error')
    return false
  }

  setStatus('checking')

  try {
    // Force the browser to fetch /sw.js from server and compare
    await reg.update()
  } catch {
    setStatus('error')
    return false
  }

  // After update(), check if a new SW appeared
  // reg.installing = new SW being installed
  // reg.waiting = new SW installed, waiting to activate
  // If either exists, an update was found
  if (reg.installing || reg.waiting) {
    setStatus('found')
    // skipWaiting is already in the SW — controllerchange will auto-reload
    return true
  }

  setStatus('up-to-date')
  return false
}
