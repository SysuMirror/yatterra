/**
 * PWA 增强能力：持久化存储 + 周期性后台同步。
 *
 * 两者都只在「已安装」的 PWA 上完整生效：
 * - Persistent Storage：让浏览器不要因为空间紧张就清掉我们的缓存；
 * - Periodic Background Sync：后台定期刷新未读数，让图标角标不依赖页面打开。
 */
const PERIODIC_TAG = 'yatterra-badge-refresh'
const PERIODIC_MIN_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

type PeriodicSyncManager = {
  register: (tag: string, options: { minInterval: number }) => Promise<void>
  unregister: (tag: string) => Promise<void>
  getTags: () => Promise<string[]>
}

type RegWithPeriodic = ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager }

// ── 持久化存储 ───────────────────────────────────────────────

export async function isStoragePersisted(): Promise<boolean> {
  if (!navigator.storage?.persisted) return false
  try { return await navigator.storage.persisted() } catch { return false }
}

/** 请求持久化存储；已持久化或浏览器不弹窗时直接返回结果。 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

// ── 周期性后台同步 ───────────────────────────────────────────

export function isPeriodicSyncSupported(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  return 'periodicSync' in ServiceWorkerRegistration.prototype
}

async function getRegistration(): Promise<RegWithPeriodic | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return (await navigator.serviceWorker.getRegistration()) as RegWithPeriodic | null
  } catch {
    return null
  }
}

export async function enablePeriodicBadgeSync(reg?: RegWithPeriodic | null): Promise<boolean> {
  const r = reg ?? (await getRegistration())
  const sync = r?.periodicSync
  if (!sync) return false
  try {
    await sync.register(PERIODIC_TAG, { minInterval: PERIODIC_MIN_INTERVAL_MS })
    return true
  } catch {
    return false
  }
}

export async function disablePeriodicBadgeSync(reg?: RegWithPeriodic | null): Promise<boolean> {
  const r = reg ?? (await getRegistration())
  const sync = r?.periodicSync
  if (!sync) return false
  try {
    await sync.unregister(PERIODIC_TAG)
    return true
  } catch {
    return false
  }
}

export async function isPeriodicBadgeSyncEnabled(reg?: RegWithPeriodic | null): Promise<boolean> {
  const r = reg ?? (await getRegistration())
  const sync = r?.periodicSync
  if (!sync) return false
  try {
    return (await sync.getTags()).includes(PERIODIC_TAG)
  } catch {
    return false
  }
}

/** 启动时调用：请求持久化存储；若已授权通知则顺带注册后台同步。 */
export async function initPwaEnhancements(): Promise<void> {
  await requestPersistentStorage()
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  // 后台同步需要 SW 已激活；用 ready 等它就绪，避免首次访问时注册失败。
  try {
    const reg = (await navigator.serviceWorker.ready) as RegWithPeriodic
    if (isPeriodicSyncSupported() && !(await isPeriodicBadgeSyncEnabled(reg))) {
      await enablePeriodicBadgeSync(reg)
    }
  } catch {
    // 忽略：首次注册 / 权限策略不允许时不影响前台
  }
}

/** 通知订阅状态变化后调用，尽量让后台同步与推送权限保持一致。 */
export async function syncPeriodicBadgeWithPush(pushEnabled: boolean): Promise<void> {
  const reg = await getRegistration()
  if (!reg || !isPeriodicSyncSupported()) return
  if (pushEnabled) await enablePeriodicBadgeSync(reg)
  else await disablePeriodicBadgeSync(reg)
}
