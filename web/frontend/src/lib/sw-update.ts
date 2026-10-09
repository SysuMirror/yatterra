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
  if (!reg) { setStatus('error'); return }
  setStatus('checking')
  // worker 可能还在 installing(预缓存未完成),等它到 waiting 再发 SKIP_WAITING;
  // 直接对 installing 的发消息会被丢弃,按钮就"点了没反应"。
  const worker = await waitForWaiting(reg)
  if (!worker) { setStatus('error'); return }
  worker.postMessage({ type: 'SKIP_WAITING' })
}

function waitForWaiting(reg: ServiceWorkerRegistration, timeoutMs = 30_000): Promise<ServiceWorker | null> {
  if (reg.waiting) return Promise.resolve(reg.waiting)
  const installing = reg.installing
  if (!installing) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(reg.waiting), timeoutMs)
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' || installing.state === 'activated') {
        window.clearTimeout(timer)
        resolve(reg.waiting || (installing.state === 'activated' ? installing : null))
      }
    })
  })
}
