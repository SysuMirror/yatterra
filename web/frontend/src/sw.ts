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

// ── App Badging ──────────────────────────────────────────────
// WorkerNavigator 在 TS 的 lib 里还没声明 Badging API，这里自行窄化。
const badgeNavigator = self.navigator as WorkerNavigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

async function applyBadge(count: number): Promise<void> {
  if (typeof badgeNavigator.setAppBadge !== 'function') return
  try {
    if (count > 0) await badgeNavigator.setAppBadge(count)
    else await badgeNavigator.clearAppBadge?.()
  } catch {
    // 未安装 / 平台不支持，静默忽略
  }
}

/** 拉一次未读数并刷新图标角标（后台同步、推送到达时用）。 */
async function refreshBadgeFromServer(): Promise<void> {
  try {
    const res = await fetch('/api/push/events?unread_only=1&limit=1', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return
    const data = (await res.json()) as { unread?: number }
    await applyBadge(Number(data?.unread) || 0)
  } catch {
    // 离线或接口不可达时保留上一次的角标
  }
}

// registerType: 'prompt' — 新版本停在 waiting,等用户点「刷新获取新版本」
// (main.tsx 发 SKIP_WAITING)后才接管。install 时不能无条件 skipWaiting,
// 否则永远没有 waiting worker,按钮取 reg.waiting 恒为 null 变成 no-op。
clientsClaim()
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames.map((name) => caches.delete(name)))
    await self.clients.claim()
  })()
  )
})
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
  // 页面侧未读数变化时把角标同步给 SW —— 页面关闭后角标仍会保留。
  if (event.data?.type === 'SET_APP_BADGE') {
    event.waitUntil(applyBadge(Number(event.data?.count) || 0))
  }
})

// ── 周期性后台同步 ───────────────────────────────────────────
// 已安装的 PWA 上由浏览器定期唤醒，刷新未读角标；页面没开也能更新。
self.addEventListener('periodicsync' as 'push', ((event: ExtendableEvent & { tag?: string }) => {
  if (event.tag === 'yatterra-badge-refresh') {
    event.waitUntil(refreshBadgeFromServer())
  }
}) as EventListener)

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
    (async () => {
      await self.registration.showNotification(title, {
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
      })
      // 推送到达大概率意味着有新的未读，顺手把图标角标刷新一下。
      await refreshBadgeFromServer()
    })(),
  )
})

// 订阅可能被浏览器/推送服务轮换，重订阅后回传服务端，避免静默失效。
self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent & {
  oldSubscription?: PushSubscription
  newSubscription?: PushSubscription | null
}) => {
  event.waitUntil((async () => {
    let sub = event.newSubscription ?? null
    if (!sub) {
      const reg = self.registration
      const key = event.oldSubscription?.options?.applicationServerKey
      if (!reg || !key) return
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    }
    try {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
    } catch {
      // 离线时交给下次前台订阅兜底
    }
  })())
}) as EventListener)

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
