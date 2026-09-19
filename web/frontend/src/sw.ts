/// <reference lib="webworker" />
/**
 * Custom Service Worker — Workbox precaching, safe offline navigation, and push.
 *
 * VitePWA injectManifest mode replaces __WB_MANIFEST at build time.
 */
declare const self: ServiceWorkerGlobalScope

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { NetworkFirst, CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { clientsClaim } from 'workbox-core'

// Build assets, including offline.html, are immutable and safe to precache.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Keep a new worker waiting until the user explicitly accepts the update.
// This prevents a background tab from being refreshed while a form is open.
clientsClaim()
self.addEventListener('activate', (event) => {
  // Remove the previous broad API cache, which could contain personalized
  // infrastructure responses from an older service-worker version.
  event.waitUntil(Promise.all([
    caches.delete('api-cache'),
    caches.delete('navigation-pages'),
    caches.delete('static-assets'),
  ]))
})
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

const offlineHandler = createHandlerBoundToURL('/offline.html')

// Navigations use the network when possible, then a short-lived cached shell;
// if neither exists, show the standalone offline page. API and OAuth requests
// are deliberately excluded so they can never receive HTML from this route.
const navigationStrategy = new NetworkFirst({
  cacheName: 'yatterra-navigation-v2',
  networkTimeoutSeconds: 3,
  plugins: [
    new CacheableResponsePlugin({ statuses: [200] }),
    new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 }),
  ],
})

registerRoute(
  new NavigationRoute(
    async ({ event, request, url }) => {
      try {
        return await navigationStrategy.handle({ event, request, url })
      } catch {
        return offlineHandler({ event, request, url })
      }
    },
    { denylist: [/^\/api\//, /^\/oauth\//] },
  ),
)

// Do not persist API responses: this app serves personalized infrastructure
// data and secrets. Queries still work online and React Query retains a short
// in-memory cache for fast in-app navigation. Mutations are never queued.

// Versioned/static resources are safe to reuse across sessions.
registerRoute(
  ({ url, request, sameOrigin }) =>
    request.method === 'GET'
    && sameOrigin
    && /\.(ttf|woff2|css|js)$/.test(url.pathname),
  new CacheFirst({
      cacheName: 'yatterra-static-v2',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 }),
    ],
  }),
  'GET',
)

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

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'dismiss') return

  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return (client as WindowClient).focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
