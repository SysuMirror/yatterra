/** User-controlled service worker update flow. */
export type UpdateStatus = 'idle' | 'checking' | 'found' | 'up-to-date' | 'error'

let status: UpdateStatus = 'idle'
let registration: ServiceWorkerRegistration | null = null
const listeners = new Set<(status: UpdateStatus) => void>()

function setStatus(next: UpdateStatus) {
  status = next
  listeners.forEach((listener) => listener(next))
}

export function onStatusChange(listener: (status: UpdateStatus) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function getStatus() { return status }

function watchRegistration(reg: ServiceWorkerRegistration) {
  if (registration === reg) return
  registration = reg
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) setStatus('found')
    })
  })
}

export async function checkForUpdate(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) { setStatus('error'); return false }
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) { setStatus('error'); return false }
  watchRegistration(reg)
  setStatus('checking')
  try { await reg.update() } catch { setStatus('error'); return false }
  if (reg.waiting || reg.installing) {
    setStatus('found')
    return true
  }
  setStatus('up-to-date')
  return false
}

export async function acceptUpdate(): Promise<void> {
  const reg = registration || await navigator.serviceWorker.getRegistration()
  const worker = reg?.waiting
  if (!worker) return
  setStatus('checking')
  worker.postMessage({ type: 'SKIP_WAITING' })
}
