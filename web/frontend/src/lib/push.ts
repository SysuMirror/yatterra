/**
 * Push notification subscription utility — native Push API + VAPID.
 *
 * Flow:
 * 1. getVapidKey() → fetch public key from server
 * 2. subscribePush() → request permission + pushManager.subscribe + POST to server
 * 3. unsubscribePush() → pushManager.unsubscribe + POST to server
 * 4. getSubscriptionState() → current permission + subscription status
 */
import { api } from '@/api/client'

// ── VAPID public key ─────────────────────────────────────────

let _vapidKey: string | undefined

export async function getVapidKey(): Promise<string> {
  if (_vapidKey) return _vapidKey
  const res = await api.get<{ publicKey: string }>('/push/vapid-key')
  _vapidKey = res.publicKey
  return _vapidKey
}

// ── Helpers ──────────────────────────────────────────────────

/** Convert base64 URL-safe string to Uint8Array for applicationServerKey */
function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64String = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64String)
  // Build over an explicit ArrayBuffer — `Uint8Array.from` widens to
  // ArrayBufferLike, which PushManager.subscribe's BufferSource rejects.
  const out = new Uint8Array(new ArrayBuffer(rawData.length))
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i)
  return out
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'not-subscribed'

export async function getSubscriptionState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported'

  if (Notification.permission === 'denied') return 'denied'

  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return 'not-subscribed'

  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'not-subscribed'
}

// ── Subscribe ────────────────────────────────────────────────

export async function subscribePush(): Promise<boolean> {
  if (!isPushSupported()) return false

  // Request permission
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  // Get SW registration
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return false

  // Get VAPID key
  const vapidKey = await getVapidKey()

  // Subscribe
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(vapidKey),
  })

  // Send to server
  const subJson = subscription.toJSON()
  await api.post('/push/subscribe', subJson)

  return true
}

// ── Unsubscribe ──────────────────────────────────────────────

export async function unsubscribePush(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return false

  const subscription = await reg.pushManager.getSubscription()
  if (!subscription) return true

  const endpoint = subscription.endpoint

  // Unsubscribe from push service
  await subscription.unsubscribe()

  // Notify server
  await api.post('/push/unsubscribe', { endpoint })

  return true
}
