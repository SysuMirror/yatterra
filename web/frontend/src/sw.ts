/// <reference lib="webworker" />
/**
 * Custom Service Worker — workbox precaching + push notifications.
 *
 * VitePWA injectManifest mode: workbox injects __WB_MANIFEST into this file
 * at build time, replacing the placeholder below.
 */
declare const self: ServiceWorkerGlobalScope

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { createHandlerBoundToURL } from 'workbox-precaching'
import { NetworkFirst } from 'workbox-strategies'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { clientsClaim } from 'workbox-core'

// ── Precache all build assets ────────────────────────────────
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── Take control immediately ─────────────────────────────────
self.skipWaiting()
clientsClaim()

// ── Navigation fallback (SPA) ────────────────────────────────
// Exclude /api/ and /oauth/ from SW navigation interception so that OAuth
// redirects (e.g. /api/auth/oauth/ssemarket → 302) and callbacks reach the
// backend instead of being swallowed by the SPA shell (which 404s them).
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/api\//, /^\/oauth\//],
}))

// ── Runtime caching ──────────────────────────────────────────
// API: NetworkFirst (10s timeout) — but never cache credential-bearing
// endpoints (storage/databases return root secrets for admins); those must
// always hit the network so secrets never linger in Cache Storage.
registerRoute(
  ({ url, request, sameOrigin }) =>
    request.method === 'GET'
    && sameOrigin
    && url.pathname.startsWith('/api/')
    && !/^\/api\/(infra\/(storage|databases)|users)/.test(url.pathname),
  new NetworkFirst({
    networkTimeoutSeconds: 10,
    cacheName: 'api-cache',
  }),
)

// Static assets: CacheFirst (30 days)
registerRoute(
  /\.(ttf|woff2|css|js)$/,
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 })],
  }),
  'GET',
)

// ── Push notifications ───────────────────────────────────────
self.addEventListener('push', (event) => {
  let data: { title?: string; body?: string; url?: string } = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    data = {}
  }

  const title = data.title || 'sseinfra 更新'
  const body = data.body || '新版本已部署，点击刷新获取最新功能'

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      data: { url: data.url || '/' },
      // `vibrate` and `actions` are valid in the spec and honoured by
      // Chrome/Firefox, but TS's DOM lib doesn't declare them — spread a
      // cast so the extra keys survive without widening the whole object.
      ...({
        vibrate: [100, 50, 100],
        actions: [
          { action: 'refresh', title: '刷新' },
          { action: 'dismiss', title: '稍后' },
        ],
      } as NotificationOptions),
    }),
  )
})

// ── Notification click ───────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // If user clicked "dismiss", do nothing
  if (event.action === 'dismiss') return

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open, otherwise open new
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return (client as WindowClient).focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
